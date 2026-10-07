import json
import os
import uuid

from aiohttp import web
from config.logger import setup_logging
from core.api.base_handler import BaseHandler
from core.utils.auth import AuthToken
from typing import Tuple, Optional

TAG = __name__

# 视频文件魔数白名单：webm/matroska(EBML头)、mp4/quicktime(ftyp盒子)
VIDEO_MAGIC_BYTES = (
    b"\x1a\x45\xdf\xa3",  # EBML头：webm / mkv
    b"ftyp",                  # mp4/mov：第4字节起为ftyp
)

# 允许的Content-Type（宽松匹配，浏览器MediaRecorder常见取值）
ALLOWED_CONTENT_TYPES = (
    "video/webm",
    "video/mp4",
    "video/x-matroska",
    "video/quicktime",
    "video/ogg",
    "application/octet-stream",  # 部分客户端不设置具体类型时放行，由魔数兜底
)


class VideoHandler(BaseHandler):
    """接收客户端上传的录像片段，投递给对应设备的录像编排器。

    鉴权方式与 /mcp/vision/explain 完全一致：
      Bearer token + Device-Id 一致性校验 + 大小限制。
    """

    def __init__(self, config: dict):
        super().__init__(config)
        self.auth = AuthToken(config["server"]["auth_key"])
        video_cfg = (config.get("features", {}) or {}).get("video_input", {}) or {}
        self.max_file_mb = int(video_cfg.get("max_file_mb", 25))

    def _create_error_response(self, message: str) -> dict:
        return {"success": False, "message": message}

    def _verify_auth_token(self, request) -> Tuple[bool, Optional[str]]:
        """验证认证token（与VisionHandler同逻辑）"""
        auth_header = request.headers.get("Authorization", "")
        client_id = request.headers.get("Client-Id", "")

        # 允许测试客户端跳过认证
        if client_id == "web_test_client":
            device_id = request.headers.get("Device-Id", "test_device")
            return True, device_id

        if not auth_header.startswith("Bearer "):
            return False, None

        token = auth_header[7:]  # 移除"Bearer "前缀
        return self.auth.verify_token(token)

    @staticmethod
    def _is_valid_video(data: bytes) -> bool:
        """魔数校验是否为常见视频格式（webm/mp4/mkv/mov）"""
        if data.startswith(VIDEO_MAGIC_BYTES[0]):
            return True
        if len(data) > 8 and data[4:8] == VIDEO_MAGIC_BYTES[1]:
            return True
        return False

    def _json(self, payload: dict, status: int = 200) -> web.Response:
        return web.Response(
            text=json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
            content_type="application/json",
            status=status,
        )

    async def handle_post(self, request):
        """处理视频上传 POST 请求"""
        tmp_path = None
        try:
            # 1. 验证token
            is_valid, token_device_id = self._verify_auth_token(request)
            if not is_valid:
                return self._json(
                    self._create_error_response("无效的认证token或token已过期"), 401
                )

            # 2. 设备ID一致性校验
            device_id = request.headers.get("Device-Id", "")
            if device_id != token_device_id:
                return self._json(
                    self._create_error_response("设备ID与token不匹配"), 401
                )

            # 3. 找到该设备的活跃连接
            from core.connection import ConnectionHandler

            conn = ConnectionHandler.get_active_by_device(device_id)
            if conn is None:
                return self._json(
                    self._create_error_response("该设备没有活跃的会话"), 404
                )
            video_ctrl = getattr(conn, "video", None)
            if video_ctrl is None or not video_ctrl.enabled:
                return self._json(
                    self._create_error_response("该设备未启用视频输入功能"), 404
                )

            # 4. 解析multipart表单：request_id 字段 + video 文件
            reader = await request.multipart()
            request_id = None
            video_data = None
            content_type = "video/webm"
            async for part in reader:
                if part.name == "request_id":
                    request_id = (await part.text()).strip()
                elif part.name == "video":
                    content_type = (
                        part.headers.get("Content-Type", "") or "video/webm"
                    ).split(";")[0].strip().lower()
                    video_data = await part.read()
                if request_id is not None and video_data is not None:
                    break

            if not request_id:
                return self._json(
                    self._create_error_response("缺少request_id字段"), 400
                )
            if not video_data:
                return self._json(
                    self._create_error_response("视频数据为空"), 400
                )

            # 5. 大小限制
            max_bytes = self.max_file_mb * 1024 * 1024
            if len(video_data) > max_bytes:
                return self._json(
                    self._create_error_response(
                        "视频大小超过限制，最大允许" + str(self.max_file_mb) + "MB"
                    ),
                    413,
                )

            # 6. 格式白名单：Content-Type或魔数至少一项通过
            type_ok = content_type in ALLOWED_CONTENT_TYPES
            magic_ok = self._is_valid_video(video_data)
            if not (type_ok and magic_ok) and not (type_ok or magic_ok):
                return self._json(
                    self._create_error_response(
                        "不支持的视频格式，请上传webm/mp4/mkv/mov格式"
                    ),
                    415,
                )

            # 7. 落盘临时目录并投递给连接
            tmp_dir = video_ctrl.get_tmp_dir()
            ext = ".webm" if "webm" in content_type or "matroska" in content_type else ".mp4"
            tmp_path = os.path.join(tmp_dir, "upload_" + uuid.uuid4().hex + ext)
            with open(tmp_path, "wb") as f:
                f.write(video_data)

            accepted = await video_ctrl.deliver_upload(
                request_id=request_id,
                file_path=tmp_path,
                mime_type=content_type if content_type else "video/webm",
                size_bytes=len(video_data),
            )
            tmp_path = None  # 投递成功后文件归编排器管理（消费后即删）
            if not accepted:
                return self._json(
                    self._create_error_response("没有匹配的录像会话"), 404
                )

            return self._json({"success": True})

        except web.HTTPRequestEntityTooLarge:
            return self._json(
                self._create_error_response(
                    "视频大小超过限制，最大允许" + str(self.max_file_mb) + "MB"
                ),
                413,
            )
        except Exception as e:
            self.logger.bind(tag=TAG).error(
                "MCP Video POST请求异常: " + str(e)
            )
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
            return self._json(self._create_error_response("处理请求时发生错误"), 500)

    async def handle_get(self, request):
        """GET 探活"""
        return web.Response(
            text="MCP Video 接口运行正常，视频上传接口地址是: /mcp/vision/video",
            content_type="text/plain",
        )
