from typing import Dict, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from core.connection import ConnectionHandler

from core.handle.textMessageHandler import TextMessageHandler
from core.handle.textMessageType import TextMessageType

TAG = __name__


class CameraTextMessageHandler(TextMessageHandler):
    """Camera消息处理器

    客户端对服务端下发的 camera 命令的回执，目前仅 record_started：
    收到后在1秒ack看门狗超时前取消定时器，避免录像会话被判定为"客户端不支持"。
    消息格式：{"type": "camera", "command": "record_started", "request_id": "<uuid>"}
    """

    @property
    def message_type(self) -> TextMessageType:
        return TextMessageType.CAMERA

    async def handle(self, conn: "ConnectionHandler", msg_json: Dict[str, Any]) -> None:
        command = msg_json.get("command")
        request_id = msg_json.get("request_id")

        if command == "record_started":
            video_ctrl = getattr(conn, "video", None)
            if video_ctrl is not None:
                await video_ctrl.handle_ack(request_id)
            return

        if conn.logger is not None:
            conn.logger.bind(tag=TAG).warning(
                f"收到未知的camera命令：{command}，request_id={request_id}"
            )
