# AVI(MJPG)上传支持测试（S1白名单/门禁 + S2转码层）。
# 覆盖（对齐计划文档测试清单）：
#   - _is_valid_video：合法AVI(MJPG) / RIFF非AVI(WAV) / RIFF+AVI无MJPG / 截断文件
#   - 落盘扩展名 _pick_ext：avi/webm/mp4 三分支（魔数优先）
#   - mime推断 _derive_mime：octet-stream按魔数兜底
#   - 转码降级：transcode.enabled=false → 415；ffmpeg缺失 → 415；accept_avi=false → 415
#   - 转码运行时：超时 → 500；产物魔数复检失败 → 500
#   - MJPG门禁：RIFF+AVI无MJPG → 415；标注avi类型但非AVI容器 → 415
#   - 真实ffmpeg端到端：AVI(MJPG) → 转码MP4 → 投递mime=video/mp4
#
# 注意：handler在模块导入时构造（同步上下文，无事件循环运行）——
# setup_logging→load_config 内部调用 asyncio.run，不能发生在请求循环内
# （与 test_video_handler_http.py 同一约束）。
import asyncio
import shutil
import subprocess
import sys
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web

# 提前在同步上下文导入：connection.py 顶层会执行插件自动导入链，
# 其中的配置校验调用 asyncio.run，不能发生在请求循环内。
import core.connection  # noqa: F401
from core.api.video_handler import VideoHandler
from core.connection import ConnectionHandler
from core.handle.videoInputController import VideoInputController

HEADERS = {
    "Device-Id": "test_device",
    "Client-Id": "web_test_client",  # 免鉴权测试客户端
}

EBML_MAGIC = b"\x1a\x45\xdf\xa3"


def make_avi_bytes(with_mjpg: bool = True, riff_type: bytes = b"AVI ") -> bytes:
    """构造极简RIFF文件字节（服务端只做魔数+fourcc嗅探，无需合法AVI结构）"""
    data = b"RIFF" + b"\x24\x00\x00\x00" + riff_type
    data += b"LIST" + b"\x10\x00\x00\x00" + b"strl"
    data += b"strh" + (b"MJPG" if with_mjpg else b"XVID") + b"\x00\x00\x00\x00"
    return data


def make_config(**video_overrides) -> dict:
    video_cfg = {"enabled": True, "max_file_mb": 1, "tmp_dir": "tmp/test_videos"}
    video_cfg.update(video_overrides)
    return {
        "server": {"auth_key": "test_auth_key_for_video_handler"},
        # 测试需要免鉴权旁路，须显式开启（生产默认关闭）
        "allow_test_client": True,
        "features": {"video_input": video_cfg},
    }


def make_handler(**video_overrides) -> VideoHandler:
    return VideoHandler(make_config(**video_overrides))


# 各配置变体统一在模块导入时构造（同步上下文）
_HANDLER_DEFAULT = make_handler()
_HANDLER_NO_AVI = make_handler(accept_avi=False)
_HANDLER_NO_TRANSCODE = make_handler(transcode={"enabled": False})
_HANDLER_NO_FFMPEG = make_handler(transcode={"ffmpeg_path": "no-such-ffmpeg-bin-xyz"})
# ffmpeg_path指向python解释器：保证"可用性门禁"在任何机器都通过，
# 供超时/复检失败用例注入假subprocess.run
_HANDLER_FFMPEG_PY = make_handler(transcode={"ffmpeg_path": sys.executable})


class _FakeWebSocket:
    """录像编排器下发camera命令用的假ws"""

    def __init__(self):
        self.sent = []

    async def send(self, text):
        self.sent.append(text)


def make_fake_conn() -> SimpleNamespace:
    conn = SimpleNamespace()
    conn.device_id = "test_device"
    conn.config = make_config()
    conn.logger = SimpleNamespace(
        bind=lambda tag=None: SimpleNamespace(
            info=lambda *a, **k: None,
            warning=lambda *a, **k: None,
            error=lambda *a, **k: None,
            debug=lambda *a, **k: None,
        )
    )
    conn.websocket = _FakeWebSocket()
    conn.loop = asyncio.get_running_loop()
    conn.client_abort = False
    # C2能力判定：模拟LLM声明支持视频直传
    conn.llm = SimpleNamespace(video_input="native")
    conn.video = VideoInputController(conn)
    conn.video.enabled = True
    return conn


class _ServerFixture:
    def __init__(self):
        self.runner = None
        self.base_url = None

    async def start(self, handler: VideoHandler):
        # web.Application 必须在它所运行的同一个事件循环内创建
        app = web.Application(client_max_size=9 * 1024 * 1024)
        app.router.add_get("/mcp/vision/video", handler.handle_get)
        app.router.add_post("/mcp/vision/video", handler.handle_post)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = self.runner.addresses[0][1]
        self.base_url = "http://127.0.0.1:" + str(port)

    async def stop(self):
        if self.runner is not None:
            await self.runner.cleanup()


@pytest.fixture
async def env_factory():
    """按需用指定handler起服务+注册假连接
    （自动回执record_started，避免1秒ack看门狗取消会话）"""
    created = []

    async def _make(handler: VideoHandler) -> SimpleNamespace:
        server = _ServerFixture()
        await server.start(handler)
        conn = make_fake_conn()
        ConnectionHandler.register_active(conn)
        conn.video.on_speech_start(source="vad")
        # conftest把asyncio.sleep打了立即返回的桩，须用Task机制真正让出循环
        for _ in range(3):
            await asyncio.ensure_future(asyncio.sleep(0))
        assert conn.video.session is not None
        request_id = conn.video.session.request_id
        await conn.video.handle_ack(request_id)
        env = SimpleNamespace(handler=handler, server=server, conn=conn,
                              request_id=request_id,
                              base_url=server.base_url)
        created.append(env)
        return env

    yield _make

    for env in created:
        try:
            env.conn.video.close()
            ConnectionHandler.unregister_active(env.conn)
            await env.server.stop()
        except Exception:
            pass


async def upload_video(env, data: bytes, filename: str = "record.avi",
                       content_type: str = "video/x-msvideo",
                       request_id: str = None):
    """向测试服务上传一段视频，返回(状态码, 响应JSON)"""
    form = aiohttp.FormData()
    form.add_field("request_id", request_id or env.request_id)
    form.add_field("video", data, filename=filename, content_type=content_type)
    async with aiohttp.ClientSession() as session:
        async with session.post(env.base_url + "/mcp/vision/video",
                                data=form, headers=HEADERS) as resp:
            return resp.status, await resp.json()


# ---------------------------------------------------------------------------
# S1：魔数白名单 _is_valid_video
# ---------------------------------------------------------------------------
def test_is_valid_video_avi_mjpg_ok():
    assert VideoHandler._is_valid_video(make_avi_bytes()) is True


def test_is_valid_video_riff_non_avi_rejected():
    # RIFF但非AVI容器（如WAV音频）
    assert VideoHandler._is_valid_video(make_avi_bytes(riff_type=b"WAVE")) is False


def test_is_valid_video_avi_without_mjpg_rejected():
    # RIFF+AVI但无MJPG fourcc（如XVID编码）
    assert VideoHandler._is_valid_video(make_avi_bytes(with_mjpg=False)) is False


def test_is_valid_video_truncated_rejected():
    assert VideoHandler._is_valid_video(b"RIFF") is False
    assert VideoHandler._is_valid_video(b"RIFF\x00\x00\x00\x00AVI ") is False  # 截断，无MJPG
    assert VideoHandler._is_valid_video(b"") is False
    assert VideoHandler._is_valid_video(b"just text") is False


def test_is_valid_video_legacy_formats_ok():
    assert VideoHandler._is_valid_video(EBML_MAGIC + b"\x00" * 16) is True
    assert VideoHandler._is_valid_video(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00") is True


# ---------------------------------------------------------------------------
# S1：落盘扩展名 _pick_ext（魔数优先，Content-Type兜底）
# ---------------------------------------------------------------------------
def test_pick_ext_avi_branch():
    assert VideoHandler._pick_ext(True, "video/x-msvideo", make_avi_bytes()) == ".avi"
    # Content-Type没说avi但魔数命中也要落.avi
    assert VideoHandler._pick_ext(
        VideoHandler._is_avi_video(make_avi_bytes()),
        "application/octet-stream", make_avi_bytes()) == ".avi"


def test_pick_ext_webm_branch():
    assert VideoHandler._pick_ext(False, "video/webm", EBML_MAGIC) == ".webm"
    assert VideoHandler._pick_ext(False, "video/x-matroska", b"") == ".webm"
    # octet-stream + EBML魔数 → .webm（此前会被错落为.mp4）
    assert VideoHandler._pick_ext(False, "application/octet-stream", EBML_MAGIC) == ".webm"


def test_pick_ext_mp4_branch():
    ftyp = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00"
    assert VideoHandler._pick_ext(False, "video/mp4", ftyp) == ".mp4"
    assert VideoHandler._pick_ext(False, "video/quicktime", b"") == ".mp4"
    assert VideoHandler._pick_ext(False, "application/octet-stream", ftyp) == ".mp4"


# ---------------------------------------------------------------------------
# S3前置：投递mime推断 _derive_mime
# ---------------------------------------------------------------------------
def test_derive_mime_prefers_content_type():
    assert VideoHandler._derive_mime("video/mp4", b"") == "video/mp4"


def test_derive_mime_octet_stream_falls_back_to_magic():
    assert VideoHandler._derive_mime("application/octet-stream", EBML_MAGIC) == "video/webm"
    ftyp = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00"
    assert VideoHandler._derive_mime("application/octet-stream", ftyp) == "video/mp4"
    assert VideoHandler._derive_mime("application/octet-stream", b"") == "video/webm"


# ---------------------------------------------------------------------------
# S1门禁：MJPG/容器/accept_avi（HTTP级）
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_avi_without_mjpg_returns_415(env_factory):
    env = await env_factory(_HANDLER_DEFAULT)
    status, body = await upload_video(env, make_avi_bytes(with_mjpg=False))
    assert status == 415
    assert "MJPG" in body["message"]


@pytest.mark.asyncio
async def test_non_avi_data_with_avi_content_type_returns_415(env_factory):
    # 标注为avi类型但数据不是AVI容器（RIFF/WAVE）：拒绝并提示封装为AVI
    env = await env_factory(_HANDLER_DEFAULT)
    status, body = await upload_video(env, make_avi_bytes(riff_type=b"WAVE"),
                                      content_type="video/avi")
    assert status == 415
    assert "AVI容器" in body["message"]


@pytest.mark.asyncio
async def test_accept_avi_disabled_returns_415(env_factory):
    env = await env_factory(_HANDLER_NO_AVI)
    status, body = await upload_video(env, make_avi_bytes())
    assert status == 415
    assert "不支持的视频格式" in body["message"]


@pytest.mark.asyncio
async def test_plain_junk_still_returns_415(env_factory):
    env = await env_factory(_HANDLER_DEFAULT)
    status, body = await upload_video(env, b"just text", filename="evil.txt",
                                      content_type="text/plain")
    assert status == 415
    assert "不支持的视频格式" in body["message"]


# ---------------------------------------------------------------------------
# S2：转码降级策略（HTTP级）
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_avi_transcode_disabled_returns_415(env_factory):
    env = await env_factory(_HANDLER_NO_TRANSCODE)
    status, body = await upload_video(env, make_avi_bytes())
    assert status == 415
    assert "未启用转码" in body["message"]


@pytest.mark.asyncio
async def test_avi_ffmpeg_missing_returns_415(env_factory):
    env = await env_factory(_HANDLER_NO_FFMPEG)
    status, body = await upload_video(env, make_avi_bytes())
    assert status == 415
    assert "ffmpeg" in body["message"]


# ---------------------------------------------------------------------------
# S2：转码运行时（超时/复检失败，注入假subprocess.run）
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_avi_transcode_timeout_returns_500(env_factory, monkeypatch):
    env = await env_factory(_HANDLER_FFMPEG_PY)

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout", 0))

    monkeypatch.setattr(subprocess, "run", fake_run)
    status, body = await upload_video(env, make_avi_bytes())
    assert status == 500
    assert "超时" in body["message"]


@pytest.mark.asyncio
async def test_avi_transcode_recheck_fail_returns_500(env_factory, monkeypatch):
    env = await env_factory(_HANDLER_FFMPEG_PY)

    def fake_run(cmd, **kwargs):
        # 假ffmpeg：退出码0但产物不是MP4（魔数复检应失败）
        out_path = cmd[-1]
        with open(out_path, "wb") as f:
            f.write(b"junk-not-mp4-bytes")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    status, body = await upload_video(env, make_avi_bytes())
    assert status == 500
    assert "魔数" in body["message"]


# ---------------------------------------------------------------------------
# S2端到端：真实ffmpeg把AVI(MJPG)转成MP4后投递
# ---------------------------------------------------------------------------
@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="本机无ffmpeg，跳过真实转码端到端")
@pytest.mark.asyncio
async def test_avi_mjpg_upload_transcodes_to_mp4(env_factory, tmp_path):
    env = await env_factory(_HANDLER_DEFAULT)
    # 用ffmpeg预生成1秒 MJPG 编码的AVI样例
    sample = tmp_path / "sample.avi"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i",
         "testsrc=duration=1:size=64x48:rate=8",
         "-c:v", "mjpeg", "-q:v", "5", str(sample)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True,
    )
    data = sample.read_bytes()
    # 确认样例确为AVI(MJPG)：RIFF魔数 + AVI标识 + 头部MJPG fourcc
    assert data[:4] == b"RIFF" and data[8:12] == b"AVI "
    assert b"MJPG" in data[:4096]

    status, body = await upload_video(env, data)
    assert status == 200, body
    assert body["success"] is True

    pending = env.conn.video.pending_video
    assert pending is not None
    # 转码后投递的必须是标准MP4
    assert pending["mime_type"] == "video/mp4"
    assert pending["file_path"].endswith(".mp4")
    with open(pending["file_path"], "rb") as f:
        head = f.read(12)
    assert head[4:8] == b"ftyp"

    # read_video_as_part组装出的分片应为 data:video/mp4 前缀（直入LLM上下文的形态）
    part = env.conn.video.read_video_as_part(pending)
    assert part["type"] == "video_url"
    assert part["video_url"]["url"].startswith("data:video/mp4;base64,")
