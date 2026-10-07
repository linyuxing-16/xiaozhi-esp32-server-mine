"""录像编排器 VideoInputController 状态机测试。

覆盖：触发条件判定（开关/LLM能力/冷却/唤醒抑制/manual模式）、
ack回执、上传投递、chat侧取用、超时纯文本回退、打断取消、关闭清理。

注意：生产中 chat() 在执行器线程调用 take_pending_video（经
run_coroutine_threadsafe 回到连接事件循环），因此涉及取用的测试
用线程模拟该模型；conftest 会把 asyncio.sleep 换成不真正让出
循环的桩，故用 _flush()（Task机制）强制事件循环迭代。
"""
import asyncio
import json
import os
import threading
import time
from types import SimpleNamespace

import pytest

from core.handle.videoInputController import VideoInputController


class FakeWebSocket:
    def __init__(self):
        self.sent = []

    async def send(self, text):
        self.sent.append(json.loads(text))


class FakeLogger:
    def __init__(self):
        self.records = []

    def bind(self, tag=None):
        return self

    def _log(self, level, msg):
        self.records.append((level, str(msg)))

    info = _log
    warning = _log
    error = _log
    debug = _log


def make_conn(**video_cfg_overrides) -> SimpleNamespace:
    """构造一个最小可用的假连接对象"""
    video_cfg = {
        "enabled": True,
        "trigger_on_vad": True,
        "trigger_on_listen_start": True,
        "cooldown_ms": 0,  # 测试默认不冷却
        "max_duration_ms": 5000,
        "min_duration_ms": 800,
        "upload_wait_timeout_ms": 600,
        "max_file_mb": 25,
        "keep_video_turns": 1,
        "tmp_dir": "tmp/test_videos",
    }
    video_cfg.update(video_cfg_overrides)
    conn = SimpleNamespace()
    conn.config = {"features": {"video_input": video_cfg}}
    conn.logger = FakeLogger()
    conn.websocket = FakeWebSocket()
    conn.loop = None  # 由测试注入
    conn.just_woken_up = False
    conn.client_listen_mode = "auto"
    conn.client_abort = False
    conn.llm = SimpleNamespace(video_input="native")
    conn.video = VideoInputController(conn)
    return conn


async def _flush(iterations: int = 3):
    """强制事件循环迭代若干次，让 run_coroutine_threadsafe 调度的协程执行。

    conftest 把 asyncio.sleep 打了立即返回的桩（await 普通协程不回到
    事件循环），用 ensure_future 的 Task 机制保证至少迭代一次。
    """
    for _ in range(iterations):
        await asyncio.ensure_future(asyncio.sleep(0))


def _take_in_thread(ctrl, results):
    """在生产中 chat 于执行器线程调用 take_pending_video，这里用线程模拟"""
    results["video"] = ctrl.take_pending_video()


async def _take_with_loop_yield(ctrl):
    """线程调用 take_pending_video，同时让出循环供其内部协程运行"""
    results = {}
    t = threading.Thread(target=_take_in_thread, args=(ctrl, results))
    t.start()
    while t.is_alive():
        await _flush(1)
    t.join(timeout=1)
    return results.get("video")


def _write_fake_video(ctrl, name, content=b"\x1a\x45\xdf\xa3fakevideo"):
    path = os.path.join(ctrl.get_tmp_dir(), name)
    with open(path, "wb") as f:
        f.write(content)
    return path


# ---------------------------------------------------------------------------
# 触发条件（C1~C4）
# ---------------------------------------------------------------------------

def test_disabled_when_no_features_section():
    """无features配置时功能关闭"""
    c = SimpleNamespace()
    c.config = {}
    c.logger = FakeLogger()
    ctrl = VideoInputController(c)
    assert ctrl.enabled is False


@pytest.mark.asyncio
async def test_trigger_sends_start_record():
    conn = make_conn()
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    assert len(conn.websocket.sent) == 1
    msg = conn.websocket.sent[0]
    assert msg["type"] == "camera"
    assert msg["command"] == "start_record"
    assert msg["max_duration_ms"] == 5000
    assert ctrl.session is not None


@pytest.mark.asyncio
async def test_trigger_ignored_when_llm_not_native():
    conn = make_conn()
    conn.llm.video_input = "none"
    conn.loop = asyncio.get_running_loop()
    conn.video.on_speech_start(source="vad")
    await _flush()
    assert len(conn.websocket.sent) == 0
    assert conn.video.session is None


@pytest.mark.asyncio
async def test_trigger_ignored_when_disabled():
    conn = make_conn(enabled=False)
    conn.loop = asyncio.get_running_loop()
    conn.video.on_speech_start(source="vad")
    await _flush()
    assert conn.video.session is None


@pytest.mark.asyncio
async def test_trigger_ignored_in_manual_mode():
    conn = make_conn()
    conn.client_listen_mode = "manual"
    conn.loop = asyncio.get_running_loop()
    conn.video.on_speech_start(source="vad")
    await _flush()
    assert conn.video.session is None


@pytest.mark.asyncio
async def test_trigger_ignored_during_wakeup_suppression():
    conn = make_conn()
    conn.just_woken_up = True
    conn.loop = asyncio.get_running_loop()
    conn.video.on_speech_start(source="vad")
    await _flush()
    assert conn.video.session is None


@pytest.mark.asyncio
async def test_cooldown_blocks_retrigger():
    conn = make_conn(cooldown_ms=60000)
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    assert len(conn.websocket.sent) == 1
    # 会话结束后在冷却期内再次触发：被拦截
    ctrl.session = None
    ctrl.on_speech_start(source="vad")
    await _flush()
    assert len(conn.websocket.sent) == 1


@pytest.mark.asyncio
async def test_duplicate_trigger_reuses_active_session():
    conn = make_conn()
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    count = len(conn.websocket.sent)
    ctrl.on_speech_start(source="vad")
    await _flush()
    assert len(conn.websocket.sent) == count


# ---------------------------------------------------------------------------
# 回执与停止
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ack_marks_session():
    conn = make_conn()
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    await ctrl.handle_ack(ctrl.session.request_id)
    assert ctrl.session.acked is True
    assert ctrl.client_supported is True


@pytest.mark.asyncio
async def test_voice_stop_sends_stop_record():
    conn = make_conn()
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    ctrl.on_speech_stop()
    await _flush()
    commands = [m["command"] for m in conn.websocket.sent]
    assert commands == ["start_record", "stop_record"]


# ---------------------------------------------------------------------------
# 上传投递与chat取用
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_deliver_upload_and_take_and_read():
    conn = make_conn()
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    request_id = ctrl.session.request_id

    file_path = _write_fake_video(ctrl, "fake_" + request_id + ".webm")
    accepted = await ctrl.deliver_upload(request_id, file_path, "video/webm", 10)
    assert accepted is True

    video = await _take_with_loop_yield(ctrl)
    assert video is not None
    assert video["request_id"] == request_id

    part = ctrl.read_video_as_part(video)
    assert part is not None
    assert part["type"] == "video_url"
    assert part["video_url"]["url"].startswith("data:video/webm;base64,")
    # 读取后临时文件即删
    assert not os.path.exists(video["file_path"])


@pytest.mark.asyncio
async def test_upload_with_unknown_request_id_rejected():
    conn = make_conn()
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    file_path = _write_fake_video(ctrl, "fake_unknown.webm", b"\x1a\x45\xdf\xa3x")
    accepted = await ctrl.deliver_upload("wrong_id", file_path, "video/webm", 5)
    assert accepted is False
    assert not os.path.exists(file_path)  # 误传文件被清理


@pytest.mark.asyncio
async def test_take_returns_none_immediately_when_no_session():
    conn = make_conn(upload_wait_timeout_ms=3000)
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    start = time.monotonic()
    video = await _take_with_loop_yield(ctrl)
    elapsed = time.monotonic() - start
    assert video is None
    assert elapsed < 1.0  # 无会话时立即返回，不等待


@pytest.mark.asyncio
async def test_take_returns_none_when_client_unsupported():
    conn = make_conn(upload_wait_timeout_ms=3000)
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    ctrl.client_supported = False  # 模拟ack超时已判定不支持
    start = time.monotonic()
    video = await _take_with_loop_yield(ctrl)
    elapsed = time.monotonic() - start
    assert video is None
    assert elapsed < 1.0


@pytest.mark.asyncio
async def test_take_times_out_pure_text_fallback():
    conn = make_conn(upload_wait_timeout_ms=300)
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    await ctrl.handle_ack(ctrl.session.request_id)
    start = time.monotonic()
    video = await _take_with_loop_yield(ctrl)
    elapsed = time.monotonic() - start
    assert video is None
    assert elapsed >= 0.3  # 走满等待窗口
    assert elapsed < 5.0


@pytest.mark.asyncio
async def test_video_delivered_mid_wait_is_taken():
    """等待期间视频到达：take立即返回视频而非等满超时"""
    conn = make_conn(upload_wait_timeout_ms=5000)
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    request_id = ctrl.session.request_id
    await ctrl.handle_ack(request_id)

    results = {}

    def chat_thread():
        results["video"] = ctrl.take_pending_video()

    t = threading.Thread(target=chat_thread)
    t.start()
    # chat线程等待期间视频上传到达（让出式等待，不能join阻塞循环线程）
    await _flush(2)
    file_path = _write_fake_video(ctrl, "midwait_" + request_id + ".webm")
    await ctrl.deliver_upload(request_id, file_path, "video/webm", 10)
    while t.is_alive():
        await _flush(1)
    t.join(timeout=1)
    assert results.get("video") is not None


# ---------------------------------------------------------------------------
# 打断与关闭
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_abort_cancels_wait_and_sends_stop():
    conn = make_conn(upload_wait_timeout_ms=5000)
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    request_id = ctrl.session.request_id
    await ctrl.handle_ack(request_id)

    results = {}

    def chat_thread():
        results["video"] = ctrl.take_pending_video()

    t = threading.Thread(target=chat_thread)
    t.start()
    await _flush(2)
    conn.client_abort = True
    ctrl.on_abort()
    while t.is_alive():
        await _flush(1)
    t.join(timeout=1)
    assert results.get("video") is None


@pytest.mark.asyncio
async def test_close_cleans_pending_file():
    conn = make_conn()
    conn.loop = asyncio.get_running_loop()
    ctrl = conn.video
    ctrl.on_speech_start(source="vad")
    await _flush()
    file_path = _write_fake_video(ctrl, "pending_close.webm", b"\x1a\x45\xdf\xa3x")
    await ctrl.deliver_upload(ctrl.session.request_id, file_path, "video/webm", 5)
    ctrl.close()
    assert ctrl.pending_video is None
    assert not os.path.exists(file_path)
