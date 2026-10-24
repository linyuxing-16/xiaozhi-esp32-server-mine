import asyncio
import json
import os
import shutil
import subprocess
import time
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
# AVI魔数：RIFF容器头 + "AVI "流列表标识（data[0:4]=="RIFF" 且 data[8:12]=="AVI "）
VIDEO_MAGIC_AVI = (b"RIFF", b"AVI ")
# MJPG fourcc（四字符编码）：AVI仅放行MJPG编码帧，其他编码（XVID等）设备端解不了也没必要放行
MJPG_FOURCC = b"MJPG"
# AVI头部扫描范围：判定MJPG编码时只在文件头4KB内查找fourcc
AVI_HEADER_SCAN_BYTES = 4096

# 允许的Content-Type（宽松匹配，浏览器MediaRecorder与ESP32固件常见取值）
ALLOWED_CONTENT_TYPES = (
    "video/webm",
    "video/mp4",
    "video/x-matroska",
    "video/quicktime",
    "video/ogg",
    "video/avi",                 # AVI(MJPG)：ESP32固件端录像封装
    "video/x-msvideo",           # AVI最常见的Content-Type别名
    "video/x-mjpeg",             # 部分固件按MJPEG类型标注AVI容器
    "application/octet-stream",  # 部分客户端不设置具体类型时放行，由魔数兜底
)
# AVI类Content-Type：命中即按AVI处理（容器校验 + MJPG校验 + 转码）
AVI_CONTENT_TYPES = (
    "video/avi",
    "video/x-msvideo",
    "video/x-mjpeg",
)

# AVI→MP4转码的编码参数（固定参数，与输入路径一起以参数列表传给ffmpeg，禁止shell拼接）
FFMPEG_ENCODE_ARGS = (
    "-c:v", "libx264",          # 视频重编码为H.264
    "-pix_fmt", "yuv420p",      # 像素格式：主流模型/播放器兼容
    "-movflags", "+faststart",  # MP4索引前置，便于流式读取
)


def _remove_quietly(path) -> None:
    """静默删除临时文件（不存在或被占用时忽略）"""
    if not path:
        return
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


class VideoHandler(BaseHandler):
    """接收客户端上传的录像片段，投递给对应设备的录像编排器。

    鉴权方式与 /mcp/vision/explain 完全一致：
      Bearer token + Device-Id 一致性校验 + 大小限制。

    格式处理（v1.1起）：
      - webm/mp4/mkv/mov：魔数白名单通过后直接投递；
      - AVI(MJPG)：在HTTP请求内用ffmpeg统一转码为MP4后投递，
        保证下游大模型拿到的永远是标准MP4（原始AVI不做透传）。
    """

    def __init__(self, config: dict):
        super().__init__(config)
        self.auth = AuthToken(config["server"]["auth_key"])
        video_cfg = (config.get("features", {}) or {}).get("video_input", {}) or {}
        self.max_file_mb = int(video_cfg.get("max_file_mb", 25))
        # AVI(MJPG)支持与转码配置：accept_avi控制格式白名单，transcode控制转码行为
        self.accept_avi = bool(video_cfg.get("accept_avi", True))
        transcode_cfg = video_cfg.get("transcode", {}) or {}
        self.transcode_enabled = bool(transcode_cfg.get("enabled", True))
        self.ffmpeg_path = str(transcode_cfg.get("ffmpeg_path", "ffmpeg"))
        self.transcode_timeout_sec = float(transcode_cfg.get("timeout_sec", 15))

    def _create_error_response(self, message: str) -> dict:
        return {"success": False, "message": message}

    def _verify_auth_token(self, request) -> Tuple[bool, Optional[str]]:
        """验证认证token（与VisionHandler同逻辑）"""
        auth_header = request.headers.get("Authorization", "")
        client_id = request.headers.get("Client-Id", "")

        # 免鉴权测试客户端：仅在配置显式开启 allow_test_client 时生效
        if self._is_allowed_test_client(client_id):
            device_id = request.headers.get("Device-Id", "test_device")
            return True, device_id

        if not auth_header.startswith("Bearer "):
            return False, None

        token = auth_header[7:]  # 移除"Bearer "前缀
        return self.auth.verify_token(token)

    # ------------------------------------------------------------------
    # 格式校验（魔数嗅探）
    # ------------------------------------------------------------------
    @staticmethod
    def _is_avi_video(data: bytes) -> bool:
        """AVI容器魔数判定：data[0:4]为RIFF 且 data[8:12]为AVI标识。"""
        return (
            len(data) >= 12
            and data[:4] == VIDEO_MAGIC_AVI[0]
            and data[8:12] == VIDEO_MAGIC_AVI[1]
        )

    @staticmethod
    def _avi_has_mjpg(data: bytes) -> bool:
        """AVI文件头4KB内是否出现MJPG fourcc（仅放行MJPG编码，拒绝XVID等）"""
        return MJPG_FOURCC in data[:AVI_HEADER_SCAN_BYTES]

    @staticmethod
    def _is_valid_video(data: bytes) -> bool:
        """魔数校验是否为常见视频格式（webm/mp4/mkv/mov/avi）

        AVI额外要求文件头出现MJPG fourcc——RIFF非AVI（如WAV）与
        RIFF+AVI但非MJPG编码一律不通过。
        """
        if data.startswith(VIDEO_MAGIC_BYTES[0]):
            return True
        if len(data) > 8 and data[4:8] == VIDEO_MAGIC_BYTES[1]:
            return True
        if VideoHandler._is_avi_video(data):
            return VideoHandler._avi_has_mjpg(data)
        return False

    @staticmethod
    def _is_avi_upload(content_type: str, data: bytes) -> bool:
        """本次上传是否按AVI处理：魔数或Content-Type任一命中"""
        return content_type in AVI_CONTENT_TYPES or VideoHandler._is_avi_video(data)

    @staticmethod
    def _pick_ext(is_avi: bool, content_type: str, data: bytes) -> str:
        """落盘扩展名：魔数优先、Content-Type兜底（不再"其余一律.mp4"）"""
        if is_avi:
            return ".avi"
        if (
            data.startswith(VIDEO_MAGIC_BYTES[0])
            or "webm" in content_type
            or "matroska" in content_type
        ):
            return ".webm"
        return ".mp4"

    @staticmethod
    def _derive_mime(content_type: str, data: bytes) -> str:
        """投递给编排器的mime：优先上传Content-Type；octet-stream兜底时按魔数推断"""
        if content_type and content_type != "application/octet-stream":
            return content_type
        if data.startswith(VIDEO_MAGIC_BYTES[0]):
            return "video/webm"
        if len(data) > 8 and data[4:8] == VIDEO_MAGIC_BYTES[1]:
            return "video/mp4"
        return "video/webm"

    # ------------------------------------------------------------------
    # AVI转码层（S2）：ffmpeg子进程，参数列表执行
    # ------------------------------------------------------------------
    def _ffmpeg_available(self) -> bool:
        """ffmpeg是否可用（可选依赖：缺失时AVI上传按415降级并明确报错）"""
        return bool(shutil.which(self.ffmpeg_path))

    async def _transcode_avi_to_mp4(
            self, in_path: str, out_path: str, max_duration_sec: float
    ) -> Tuple[bool, str]:
        """把AVI(MJPG)转码为标准MP4。返回(是否成功, 错误信息)。

        资源约束：
          - 输入大小已由上传步骤按 max_file_mb 拦截；
          - 输出时长封顶 max_duration_sec + 1s（MJPG帧率异常防时长膨胀）；
          - 输出大小上限与上传上限同值（max_file_mb）；
          - 产物必须通过ftyp魔数复检才算成功。
        """
        cmd = [
            self.ffmpeg_path, "-y",
            "-f", "avi",               # 强制按AVI容器解封装（不依赖ffmpeg探测）
            "-i", in_path,
            "-t", format(max_duration_sec + 1.0, ".2f"),
            *FFMPEG_ENCODE_ARGS,
            out_path,
        ]
        loop = asyncio.get_running_loop()
        try:
            # 默认线程池执行同步子进程：不阻塞事件循环；
            # subprocess.run超时会kill子进程并等待其退出
            proc = await loop.run_in_executor(
                None,
                lambda: subprocess.run(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    timeout=self.transcode_timeout_sec,
                ),
            )
        except subprocess.TimeoutExpired:
            return False, (
                "转码超时(" + format(self.transcode_timeout_sec, "g")
                + "s)，已终止ffmpeg进程"
            )
        except (FileNotFoundError, OSError) as e:
            return False, "ffmpeg启动失败: " + str(e)

        if proc.returncode != 0:
            stderr_tail = (proc.stderr or b"")[-400:].decode("utf-8", "ignore").strip()
            detail = (": " + stderr_tail) if stderr_tail else ""
            return False, "ffmpeg退出码" + str(proc.returncode) + detail

        try:
            out_size = os.path.getsize(out_path)
        except OSError:
            return False, "转码产物不存在"
        if out_size > self.max_file_mb * 1024 * 1024:
            return False, "转码产物超过大小上限(" + str(self.max_file_mb) + "MB)"

        # 产物魔数复检：必须是ftyp(MP4)
        try:
            with open(out_path, "rb") as f:
                head = f.read(8)
        except OSError:
            return False, "转码产物不可读"
        if head[4:8] != VIDEO_MAGIC_BYTES[1]:
            return False, "转码产物魔数校验失败(非MP4)"
        return True, ""

    def _json(self, payload: dict, status: int = 200) -> web.Response:
        return web.Response(
            text=json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
            content_type="application/json",
            status=status,
        )

    async def handle_post(self, request):
        """处理视频上传 POST 请求"""
        tmp_files = []  # 本请求产生的临时文件（异常时兜底清理）
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
            #    （原not(and/or)双重否定冗余条件已简化为not (type_ok or magic_ok)）
            is_avi = self._is_avi_upload(content_type, video_data)
            if is_avi and not self.accept_avi:
                return self._json(
                    self._create_error_response(
                        "不支持的视频格式，请上传webm/mp4/mkv/mov格式"
                    ),
                    415,
                )
            type_ok = content_type in ALLOWED_CONTENT_TYPES
            magic_ok = self._is_valid_video(video_data)
            if not (type_ok or magic_ok):
                return self._json(
                    self._create_error_response(
                        "不支持的视频格式，请上传webm/mp4/mkv/mov/avi(MJPG)格式"
                    ),
                    415,
                )

            if is_avi:
                # 6.1 容器校验：拒绝裸MJPEG字节流（无帧率/时长信息，LLM与转码都无法正确处理）
                if not self._is_avi_video(video_data):
                    return self._json(
                        self._create_error_response(
                            "上传数据不是AVI容器（缺少RIFF/AVI魔数），"
                            "请封装为AVI(MJPG)后上传"
                        ),
                        415,
                    )
                # 6.2 编码校验：仅放行MJPG（文件头4KB内须有MJPG fourcc）
                if not self._avi_has_mjpg(video_data):
                    return self._json(
                        self._create_error_response(
                            "AVI仅支持MJPG视频编码，请将设备端录像编码配置为MJPG"
                        ),
                        415,
                    )
                # 6.3 转码可用性（降级策略）：未启用转码或ffmpeg缺失时明确拒绝，
                #     绝不把原始AVI透传给LLM（MJPG编码在模型侧属未验证路径）
                if not self.transcode_enabled:
                    return self._json(
                        self._create_error_response(
                            "服务端未启用转码"
                            "（features.video_input.transcode.enabled=false），"
                            "无法处理AVI上传"
                        ),
                        415,
                    )
                if not self._ffmpeg_available():
                    return self._json(
                        self._create_error_response(
                            "服务端未安装ffmpeg，AVI转码不可用，无法处理AVI上传"
                        ),
                        415,
                    )

            # 7. 落盘临时目录并投递给连接
            tmp_dir = video_ctrl.get_tmp_dir()
            ext = self._pick_ext(is_avi, content_type, video_data)
            tmp_path = os.path.join(tmp_dir, "upload_" + uuid.uuid4().hex + ext)
            size_bytes = len(video_data)
            mime_type = self._derive_mime(content_type, video_data)
            with open(tmp_path, "wb") as f:
                f.write(video_data)
            tmp_files.append(tmp_path)
            video_data = None  # 大块字节提前释放（后续步骤不再需要原始数据）

            if is_avi:
                # S2转码层：AVI一律转成MP4再投递（HTTP请求内完成，编排器与chat()零改动）
                mp4_path = os.path.join(tmp_dir, "upload_" + uuid.uuid4().hex + ".mp4")
                tmp_files.append(mp4_path)
                started = time.monotonic()
                ok, err = await self._transcode_avi_to_mp4(
                    tmp_path,
                    mp4_path,
                    max_duration_sec=getattr(video_ctrl, "max_duration_ms", 5000) / 1000.0,
                )
                elapsed_ms = int((time.monotonic() - started) * 1000)
                _remove_quietly(tmp_path)  # 原始AVI用完即删，由转码产物接管投递
                tmp_files.remove(tmp_path)
                if not ok:
                    self.logger.bind(tag=TAG).warning(
                        "AVI转码失败(" + format(elapsed_ms) + "ms): " + err
                    )
                    return self._json(
                        self._create_error_response("AVI转码失败: " + err), 500
                    )
                self.logger.bind(tag=TAG).info(
                    "AVI已转码为MP4: " + format(elapsed_ms) + "ms, "
                    + format(size_bytes / 1024, ".1f") + "KB -> "
                    + format(os.path.getsize(mp4_path) / 1024, ".1f") + "KB"
                )
                tmp_path = mp4_path
                mime_type = "video/mp4"
                size_bytes = os.path.getsize(mp4_path)

            accepted = await video_ctrl.deliver_upload(
                request_id=request_id,
                file_path=tmp_path,
                mime_type=mime_type if mime_type else "video/webm",
                size_bytes=size_bytes,
            )
            tmp_files.clear()  # 文件已归编排器管理（拒绝时会自行删除，消费后即删）
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
            for path in tmp_files:
                _remove_quietly(path)
            return self._json(self._create_error_response("处理请求时发生错误"), 500)

    async def handle_get(self, request):
        """GET 探活"""
        return web.Response(
            text="MCP Video 接口运行正常，视频上传接口地址是: /mcp/vision/video",
            content_type="text/plain",
        )
