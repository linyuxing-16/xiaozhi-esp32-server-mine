# 视频上传接口 /mcp/vision/video HTTP级集成测试。
# 自起真实aiohttp服务（随机端口 + ClientSession），验证：
#   - 探活GET 200
#   - 未带token返回401
#   - 设备无活跃连接返回404
#   - 正常路径：投递给录像编排器（假连接）
#   - 超限大小返回413、错误格式返回415
import asyncio
import io
import threading
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web

# 提前在同步上下文导入：connection.py 顶层会执行插件自动导入链，
# 其中的配置校验调用 asyncio.run，不能发生在请求循环内。
import core.connection  # noqa: F401  确保ConnectionHandler可用
from core.api.video_handler import VideoHandler
from core.handle.videoInputController import VideoInputController


def make_app_config() -> dict:
    return {
        "server": {"auth_key": "test_auth_key_for_video_handler"},
        # 测试需要免鉴权旁路，须显式开启（生产默认关闭）
        "allow_test_client": True,
        "features": {"video_input": {"enabled": True, "max_file_mb": 1,
                                     "tmp_dir": "tmp/test_videos"}},
    }


def make_fake_logger():
    return SimpleNamespace(
        bind=lambda tag=None: SimpleNamespace(
            info=lambda *a, **k: None,
            warning=lambda *a, **k: None,
            error=lambda *a, **k: None,
            debug=lambda *a, **k: None,
        )
    )


class _FakeWebSocket:
    """录像编排器下发camera命令用的假ws"""

    def __init__(self):
        self.sent = []

    async def send(self, text):
        self.sent.append(text)


def make_fake_conn() -> SimpleNamespace:
    conn = SimpleNamespace()
    conn.device_id = "test_device"
    conn.config = make_app_config()
    conn.logger = make_fake_logger()
    conn.websocket = _FakeWebSocket()
    conn.loop = asyncio.get_running_loop()
    conn.client_abort = False
    # C2能力判定：模拟LLM声明支持视频直传
    conn.llm = SimpleNamespace(video_input="native")
    conn.video = VideoInputController(conn)
    conn.video.enabled = True
    return conn


HEADERS = {
    "Device-Id": "test_device",
    "Client-Id": "web_test_client",  # 免鉴权测试客户端
}

EBML_MAGIC = b"\x1a\x45\xdf\xa3"


class _ServerFixture:
    def __init__(self):
        self.runner = None
        self.base_url = None

    async def start(self, app):
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = self.runner.addresses[0][1]
        self.base_url = "http://127.0.0.1:" + str(port)

    async def stop(self):
        if self.runner is not None:
            await self.runner.cleanup()


# handler在模块导入时构造（同步上下文，无事件循环运行）：
# setup_logging→check_config_file 内部调用 asyncio.run，必须在循环外完成。
_HANDLER = VideoHandler(make_app_config())


@pytest.fixture
async def server():
    # web.Application 必须在它所运行的同一个事件循环内创建；
    # client_max_size 与 http_server.py 一致放宽，由处理器精确校验大小
    app = web.Application(client_max_size=9 * 1024 * 1024)
    app.router.add_get("/mcp/vision/video", _HANDLER.handle_get)
    app.router.add_post("/mcp/vision/video", _HANDLER.handle_post)
    fixture = _ServerFixture()
    await fixture.start(app)
    yield fixture
    await fixture.stop()


@pytest.fixture
async def http(server):
    session = aiohttp.ClientSession()
    yield SimpleNamespace(post=server.base_url + "/mcp/vision/video",
                          get=server.base_url + "/mcp/vision/video",
                          session=session)
    await session.close()


@pytest.mark.asyncio
async def test_get_probe_ok(http):
    async with http.session.get(http.get) as resp:
        assert resp.status == 200


@pytest.mark.asyncio
async def test_post_without_auth_headers_rejected(http):
    async with http.session.post(
        http.post,
        data={"request_id": "r1",
              "video": ("r.webm", io.BytesIO(EBML_MAGIC), "video/webm")},
    ) as resp:
        assert resp.status == 401  # 缺少token与设备信息


@pytest.mark.asyncio
async def test_post_no_active_connection_returns_404(http):
    async with http.session.post(
        http.post,
        headers=HEADERS,
        data={"request_id": "r1",
              "video": ("record.webm", io.BytesIO(EBML_MAGIC), "video/webm")},
    ) as resp:
        assert resp.status == 404  # 无活跃连接


@pytest.mark.asyncio
async def test_post_delivers_to_active_connection(http):
    from core.connection import ConnectionHandler

    conn = make_fake_conn()
    ConnectionHandler.register_active(conn)
    try:
        conn.video.on_speech_start(source="vad")
        # conftest把asyncio.sleep打了立即返回的桩，须用Task机制真正让出循环
        for _ in range(3):
            await asyncio.ensure_future(asyncio.sleep(0))
        assert conn.video.session is not None
        request_id = conn.video.session.request_id

        form = aiohttp.FormData()
        form.add_field("request_id", request_id)
        form.add_field("video", EBML_MAGIC, filename="record.webm", content_type="video/webm")
        async with http.session.post(
            http.post, headers=HEADERS, data=form,
        ) as resp:
            assert resp.status == 200
            body = await resp.json()
            assert body["success"] is True

        assert conn.video.pending_video is not None
        assert conn.video.pending_video["request_id"] == request_id

        # chat线程侧取用：生产中chat在执行器线程调用（经run_coroutine_threadsafe
        # 回到连接事件循环），因此用线程模拟，测试协程让出循环供其内部协程运行
        results = {}

        def chat_thread():
            results["video"] = conn.video.take_pending_video()

        t = threading.Thread(target=chat_thread)
        t.start()
        while t.is_alive():
            await asyncio.ensure_future(asyncio.sleep(0))
        video = results.get("video")
        assert video is not None
        part = conn.video.read_video_as_part(video)
        assert part["type"] == "video_url"
        assert part["video_url"]["url"].startswith("data:video/webm;base64,")
    finally:
        conn.video.close()
        ConnectionHandler.unregister_active(conn)


@pytest.mark.asyncio
async def test_post_oversized_returns_413(http):
    from core.connection import ConnectionHandler

    conn = make_fake_conn()
    ConnectionHandler.register_active(conn)
    try:
        big = EBML_MAGIC + b"x" * (1 * 1024 * 1024 + 1)
        form = aiohttp.FormData()
        form.add_field("request_id", "r1")
        form.add_field("video", big, filename="record.webm", content_type="video/webm")
        async with http.session.post(
            http.post, headers=HEADERS, data=form,
        ) as resp:
            assert resp.status == 413
    finally:
        ConnectionHandler.unregister_active(conn)


@pytest.mark.asyncio
async def test_post_bad_format_returns_415(http):
    from core.connection import ConnectionHandler

    conn = make_fake_conn()
    ConnectionHandler.register_active(conn)
    try:
        form = aiohttp.FormData()
        form.add_field("request_id", "r1")
        form.add_field("video", b"just text", filename="evil.txt", content_type="text/plain")
        async with http.session.post(
            http.post, headers=HEADERS, data=form,
        ) as resp:
            assert resp.status == 415
    finally:
        ConnectionHandler.unregister_active(conn)
