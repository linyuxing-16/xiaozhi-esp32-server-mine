import asyncio
import base64
import json
import os
import time
import uuid

TAG = __name__


class CaptureSession:
    """一次录像会话的状态"""

    def __init__(self, request_id: str):
        self.request_id = request_id
        self.created_ms = time.time() * 1000
        self.acked = False        # 客户端已回执 record_started
        self.stop_sent = False    # 已下发 stop_record
        self.uploaded = False     # 视频已上传到达
        self.done = False         # 会话已结束（上传/放弃/取消）


class VideoInputController:
    """VAD触发摄像头录像编排器。

    生命周期：
      VAD人声上升沿（或listen start）→ 下发 start_record
      人声下降沿（或到达最长时长）→ 下发 stop_record
      客户端HTTP上传 → deliver_upload 存为待用视频
      chat() → take_pending_video 取走视频，组装多模态消息
    任一环节失败都静默降级为纯文本对话，不影响正常语音流程。
    """

    def __init__(self, conn):
        self.conn = conn
        cfg = (conn.config.get("features", {}) or {}).get("video_input", {}) or {}
        # C1 功能总开关（默认关闭，隐私考虑）
        self.enabled = bool(cfg.get("enabled", False))
        self.trigger_on_vad = bool(cfg.get("trigger_on_vad", True))
        self.trigger_on_listen_start = bool(cfg.get("trigger_on_listen_start", True))
        self.cooldown_ms = int(cfg.get("cooldown_ms", 8000))
        self.max_duration_ms = int(cfg.get("max_duration_ms", 5000))
        self.upload_wait_timeout_ms = int(cfg.get("upload_wait_timeout_ms", 6000))
        self.keep_video_turns = int(cfg.get("keep_video_turns", 1))
        self.tmp_dir = str(cfg.get("tmp_dir", "tmp/videos"))
        self.max_file_mb = int(cfg.get("max_file_mb", 25))

        self.last_record_ms = 0.0        # 上次触发录像的时间戳（毫秒）
        self.client_supported = True     # 客户端是否支持camera命令（ack超时后置False）
        self.session = None              # 当前录像会话 CaptureSession
        self.pending_video = None        # 待用视频信息 dict
        self._ack_timer = None           # ack看门狗定时器
        self._max_duration_timer = None  # 最长录制看门狗定时器
        self._closed = False

    def _log(self, level, msg):
        logger = getattr(self.conn, "logger", None)
        if logger is None:
            return
        try:
            getattr(logger.bind(tag=TAG), level)(msg)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # 触发入口（C1~C4条件判定）
    # ------------------------------------------------------------------
    def _llm_supports_video(self) -> bool:
        """C2: 当前LLM是否声明支持视频输入（video_input == native）

        优先读连接级属性 llm_video_mode；缺失时回退直接查LLM实例的 video_input 声明。
        """
        mode = getattr(self.conn, "llm_video_mode", None)
        if mode is None:
            llm = getattr(self.conn, "llm", None)
            mode = getattr(llm, "video_input", "none")
        return str(mode).lower() == "native"

    def _cooldown_ok(self) -> bool:
        """C4: 距上次录像超过冷却时间"""
        return (time.time() * 1000 - self.last_record_ms) >= self.cooldown_ms

    def on_speech_start(self, source: str = "vad"):
        """人声上升沿触发录像（非阻塞，内部调度到事件循环）"""
        if self._closed or not self.enabled:
            return
        if source == "vad" and not self.trigger_on_vad:
            return
        if source == "listen" and not self.trigger_on_listen_start:
            return
        if not self._llm_supports_video():
            return
        # 刚唤醒抑制期不录像
        if getattr(self.conn, "just_woken_up", False):
            return
        # manual（手动）拾音模式不自动录像
        if getattr(self.conn, "client_listen_mode", "auto") == "manual":
            return
        if not self._cooldown_ok():
            return
        # 已有进行中的会话则复用，忽略重复触发
        if self.session is not None and not self.session.done:
            return
        if self.conn.websocket is None:
            return
        loop = getattr(self.conn, "loop", None)
        if loop is None:
            return
        self.last_record_ms = time.time() * 1000
        try:
            asyncio.run_coroutine_threadsafe(self._start_session(), loop)
        except Exception as e:
            self._log("error", "调度录像会话失败: " + str(e))

    def on_speech_stop(self):
        """人声下降沿：下发停止录像命令"""
        if self._closed:
            return
        loop = getattr(self.conn, "loop", None)
        if loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._stop_recording("voice_stop"), loop)
        except Exception as e:
            self._log("error", "调度停止录像失败: " + str(e))

    def on_abort(self):
        """用户打断时：停止录像并取消等待中的上传等待"""
        if self._closed:
            return
        loop = getattr(self.conn, "loop", None)
        if loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._on_abort_async(), loop)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # 会话生命周期（事件循环内执行）
    # ------------------------------------------------------------------
    async def _send_camera_command(self, command: str, request_id: str, **extra):
        payload = {"type": "camera", "command": command, "request_id": request_id}
        payload.update(extra)
        await self.conn.websocket.send(json.dumps(payload, ensure_ascii=False))

    async def _start_session(self):
        request_id = uuid.uuid4().hex
        session = CaptureSession(request_id)
        self.session = session
        try:
            await self._send_camera_command(
                "start_record", request_id, max_duration_ms=self.max_duration_ms
            )
        except Exception as e:
            self._log("error", "下发start_record失败: " + str(e))
            self._cancel_session(session, "send_failed")
            return
        self._log("info", "触发摄像头录像: request_id=" + request_id)
        loop = asyncio.get_running_loop()
        # ack看门狗：1秒内没有record_started回执视为客户端不支持
        self._ack_timer = loop.call_later(1.0, self._on_ack_timeout, request_id)
        # 最长录制看门狗：到时仍未停止则自动下发stop_record
        self._max_duration_timer = loop.call_later(
            self.max_duration_ms / 1000.0, self._on_max_duration, request_id
        )

    def _on_ack_timeout(self, request_id: str):
        session = self.session
        if session is None or session.request_id != request_id or session.acked:
            return
        self.client_supported = False
        self._log("info", "客户端未回执record_started，视为不支持录像，本轮放弃")
        self._cancel_session(session, "no_ack")

    def _on_max_duration(self, request_id: str):
        session = self.session
        if session is None or session.request_id != request_id:
            return
        if not session.done and not session.stop_sent:
            loop = asyncio.get_running_loop()
            loop.create_task(self._stop_recording("max_duration"))

    async def _stop_recording(self, reason: str):
        session = self.session
        if session is None or session.done or session.stop_sent:
            return
        session.stop_sent = True
        try:
            await self._send_camera_command("stop_record", session.request_id)
            self._log("debug", "下发stop_record: " + reason)
        except Exception as e:
            self._log("error", "下发stop_record失败: " + str(e))

    async def _on_abort_async(self):
        session = self.session
        if session is not None and not session.done and not session.stop_sent:
            session.stop_sent = True
            try:
                await self._send_camera_command("stop_record", session.request_id)
            except Exception:
                pass
            self._cancel_session(session, "abort")

    def _cancel_session(self, session: CaptureSession, reason: str):
        session.done = True
        if self.session is session:
            self.session = None
        self._clear_timers()
        self._log("debug", "录像会话取消: " + reason)

    def _clear_timers(self):
        if self._ack_timer is not None:
            self._ack_timer.cancel()
            self._ack_timer = None
        if self._max_duration_timer is not None:
            self._max_duration_timer.cancel()
            self._max_duration_timer = None

    # ------------------------------------------------------------------
    # 客户端回执与上传投递
    # ------------------------------------------------------------------
    async def handle_ack(self, request_id: str = None):
        """客户端回执 record_started"""
        session = self.session
        if session is None:
            return
        if request_id is None or session.request_id == request_id:
            session.acked = True
            self.client_supported = True
            if self._ack_timer is not None:
                self._ack_timer.cancel()
                self._ack_timer = None

    async def deliver_upload(
            self, request_id: str, file_path: str, mime_type: str, size_bytes: int
    ) -> bool:
        """HTTP上传接口投递视频文件。返回是否接收。"""
        if self._closed:
            self._safe_delete(file_path)
            return False
        session = self.session
        if session is None or session.request_id != request_id or session.uploaded:
            self._log("warning", "收到未匹配的录像上传: request_id=" + str(request_id) + "，丢弃")
            self._safe_delete(file_path)
            return False
        session.uploaded = True
        session.done = True
        self._clear_timers()
        self.pending_video = {
            "request_id": request_id,
            "file_path": file_path,
            "mime_type": mime_type or "video/webm",
            "size": size_bytes,
            "delivered_ms": time.time() * 1000,
        }
        self._log("info", "视频已到达: request_id=" + request_id
                  + ", " + format(size_bytes / 1024, ".1f") + "KB, " + str(mime_type))
        return True

    # ------------------------------------------------------------------
    # chat侧取用视频
    # ------------------------------------------------------------------
    async def _take_pending_video_async(self):
        """等待并取走待用视频（事件循环内执行）"""
        # 已有视频直接返回
        if self.pending_video is not None:
            return self._pop_pending_video()
        session = self.session
        # 没有进行中的会话，或客户端不支持，立即返回None不等待
        if session is None or session.done or not self.client_supported:
            return None
        deadline = time.monotonic() + self.upload_wait_timeout_ms / 1000.0
        while time.monotonic() < deadline:
            # 用户打断立即放弃等待
            if getattr(self.conn, "client_abort", False):
                self._log("info", "用户打断，放弃等待视频上传")
                return None
            if self.pending_video is not None:
                return self._pop_pending_video()
            try:
                # 经Task机制让出事件循环（普通await协程在monkeypatch环境下不会真正yield）
                await asyncio.ensure_future(asyncio.sleep(0.05))
            except asyncio.CancelledError:
                return None
        self._log("warning", "等待视频上传超时(" + str(self.upload_wait_timeout_ms) + "ms)，按纯文本回复")
        return None

    def _pop_pending_video(self):
        video = self.pending_video
        self.pending_video = None
        return video

    def take_pending_video(self):
        """取走待用视频（同步接口，供chat工作线程调用）。

        有视频返回视频信息dict；否则返回None。内部按 upload_wait_timeout_ms 等待。
        """
        loop = getattr(self.conn, "loop", None)
        if loop is None or loop.is_closed():
            return None
        future = asyncio.run_coroutine_threadsafe(
            self._take_pending_video_async(), loop
        )
        try:
            # 等待上限 = 配置超时 + 1秒调度余量
            return future.result(self.upload_wait_timeout_ms / 1000.0 + 1.0)
        except Exception:
            future.cancel()
            return None

    # ------------------------------------------------------------------
    # 视频读取与清理
    # ------------------------------------------------------------------
    def read_video_as_part(self, video: dict):
        """读取视频文件并组装成OpenAI兼容的video_url分片，读完立即删除临时文件。"""
        file_path = video.get("file_path")
        mime_type = video.get("mime_type", "video/webm")
        try:
            with open(file_path, "rb") as f:
                data = f.read()
            b64 = base64.b64encode(data).decode("utf-8")
            url = "data:" + mime_type + ";base64," + b64
            return {"type": "video_url", "video_url": {"url": url}}
        except Exception as e:
            self._log("error", "读取视频文件失败: " + str(e))
            return None
        finally:
            self._safe_delete(file_path)

    def _safe_delete(self, file_path):
        try:
            if file_path and os.path.exists(file_path):
                os.remove(file_path)
        except Exception as e:
            self._log("error", "删除视频临时文件失败: " + str(e))

    def get_tmp_dir(self) -> str:
        """确保并返回视频临时目录"""
        try:
            os.makedirs(self.tmp_dir, exist_ok=True)
        except Exception as e:
            self._log("error", "创建视频临时目录失败: " + str(e))
        return self.tmp_dir

    def close(self):
        """连接关闭时兜底清理：取消定时器、删除未消费的临时文件"""
        self._closed = True
        self._clear_timers()
        if self.pending_video is not None:
            self._safe_delete(self.pending_video.get("file_path"))
            self.pending_video = None
        session = self.session
        if session is not None and not session.done:
            session.done = True
        self.session = None
