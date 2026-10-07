import uuid
import re
from typing import List, Dict, Optional, Union
from datetime import datetime

# 用户消息 content 支持的类型：纯文本字符串 或 OpenAI 兼容的多模态分片数组
MessageContentType = Union[str, list, None]


class Message:
    def __init__(
            self,
            role: str,
            content: MessageContentType = None,
            uniq_id: str = None,
            tool_calls=None,
            tool_call_id=None,
            is_temporary=False,
            raw_text: str = None,
            has_video: bool = False,
    ):
        self.uniq_id = uniq_id if uniq_id is not None else str(uuid.uuid4())
        self.role = role
        self.content = content
        self.tool_calls = tool_calls
        self.tool_call_id = tool_call_id
        self.is_temporary = is_temporary  # 标记临时消息（如工具调用提醒）
        # 多模态扩展字段：
        # raw_text 本轮纯文本（供记忆/上报/降级后使用），缺省回退到字符串 content
        self.raw_text = raw_text if raw_text is not None else (
            content if isinstance(content, str) else None
        )
        # has_video 标记该消息是否携带视频载荷（content 为分片数组时）
        self.has_video = has_video

    def get_text(self) -> str:
        """获取本条消息的纯文本内容。

        多模态消息（content 为分片数组）返回 raw_text；
        普通消息直接返回字符串 content。记忆/上报等只关心文本的路径统一走这里。
        """
        if self.raw_text is not None:
            return self.raw_text
        if isinstance(self.content, str):
            return self.content
        if isinstance(self.content, list):
            # 兜底：从分片数组中拼接所有 text 分片
            parts = []
            for seg in self.content:
                if isinstance(seg, dict) and seg.get("type") == "text":
                    parts.append(str(seg.get("text", "")))
            return "".join(parts)
        return ""

    @staticmethod
    def has_video_payload(content) -> bool:
        """判断 content 是否包含视频分片"""
        if not isinstance(content, list):
            return False
        return any(
            isinstance(seg, dict) and seg.get("type") == "video_url"
            for seg in content
        )


class Dialogue:
    def __init__(self):
        self.dialogue: List[Message] = []
        # 获取当前时间
        self.current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def put(self, message: Message):
        self.dialogue.append(message)

    def getMessages(self, m, dialogue):
        if m.tool_calls is not None:
            dialogue.append({"role": m.role, "tool_calls": m.tool_calls})
        elif m.role == "tool":
            dialogue.append(
                {
                    "role": m.role,
                    "tool_call_id": (
                        str(uuid.uuid4()) if m.tool_call_id is None else m.tool_call_id
                    ),
                    "content": m.content,
                }
            )
        else:
            dialogue.append({"role": m.role, "content": m.content})

    def get_llm_dialogue(self) -> List[Dict[str, str]]:
        # 直接调用get_llm_dialogue_with_memory，传入None作为memory_str
        # 这样确保说话人功能在所有调用路径下都生效
        return self.get_llm_dialogue_with_memory(None, None)

    def update_system_message(self, new_content: str):
        """更新或添加系统消息"""
        # 查找第一个系统消息
        system_msg = next((msg for msg in self.dialogue if msg.role == "system"), None)
        if system_msg:
            system_msg.content = new_content
        else:
            self.put(Message(role="system", content=new_content))

    def _ensure_tool_calls_complete(self, messages: List[Message]) -> List[Message]:
        """
        确保所有 tool_calls 都有对应的 tool 响应
        修复被打断导致的悬空 tool_calls，防止大模型 API 报 400 错误
        """
        pending_tool_calls = set()
        result = []

        for msg in messages:
            result.append(msg)

            if msg.role == "assistant" and msg.tool_calls:
                for tc in msg.tool_calls:
                    tc_id = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
                    if tc_id:
                        pending_tool_calls.add(tc_id)

            elif msg.role == "tool" and msg.tool_call_id:
                pending_tool_calls.discard(msg.tool_call_id)

        for missing_id in pending_tool_calls:
            dummy_tool_msg = Message(
                role="tool",
                content='{"status": "interrupted", "message": "动作已取消/被打断"}',
                tool_call_id=missing_id
            )
            result.append(dummy_tool_msg)

        return result

    @staticmethod
    def _degrade_message_content(m: Message) -> MessageContentType:
        """把含视频的消息内容还原为纯文本（降级），其余原样返回"""
        if m.has_video or Message.has_video_payload(m.content):
            return m.get_text()
        return m.content

    def _degrade_video(
            self, messages: List[Message], keep_turns: int
    ) -> List[Message]:
        """视频降级：只保留最近 keep_turns 条带视频的用户消息的视频分片，
        更早轮次的 content 还原为 raw_text 纯文本，防止历史消息反复携带大 base64 载荷。
        返回新列表，不修改存储的 Message 对象。"""
        if keep_turns is None or keep_turns < 0:
            keep_turns = 1
        # 从后往前找出所有带视频的消息
        video_indices = [
            i for i, m in enumerate(messages)
            if (m.has_video or Message.has_video_payload(m.content))
        ]
        # 需要降级的视频消息：除最近 keep_turns 条以外的全部
        degrade_set = set(video_indices[:-keep_turns]) if keep_turns > 0 else set(video_indices)
        if not degrade_set:
            return messages
        result = []
        for i, m in enumerate(messages):
            if i in degrade_set:
                result.append(Message(
                    role=m.role,
                    content=m.get_text(),
                    tool_calls=m.tool_calls,
                    tool_call_id=m.tool_call_id,
                    is_temporary=m.is_temporary,
                    raw_text=m.get_text(),
                    has_video=False,
                ))
            else:
                result.append(m)
        return result

    def release_stored_video(self, keep_turns: int = 1):
        """回合结束后调用：就地释放存储对话中旧轮次的视频载荷（降级为纯文本），
        让 base64 字节尽快被垃圾回收。最近 keep_turns 条视频消息保留。"""
        video_indices = [
            i for i, m in enumerate(self.dialogue)
            if (m.has_video or Message.has_video_payload(m.content))
        ]
        degrade_set = set(video_indices[:-keep_turns]) if keep_turns > 0 else set(video_indices)
        for i in degrade_set:
            m = self.dialogue[i]
            m.content = m.get_text()
            m.has_video = False

    def get_llm_dialogue_with_memory(
            self, memory_str: str = None, voiceprint_config: dict = None,
            current_speaker: str = None, keep_video_turns: int = 1,
    ) -> List[Dict[str, str]]:
        # 构建对话
        dialogue = []

        # 添加系统提示和记忆
        system_message = next(
            (msg for msg in self.dialogue if msg.role == "system"), None
        )

        if system_message:
            full_prompt = system_message.content

            # 替换时间占位符
            full_prompt = full_prompt.replace(
                "{{current_time}}", datetime.now().strftime("%H:%M")
            )

            # 填充记忆
            if memory_str is not None:
                full_prompt = re.sub(
                    r"<memory>.*?</memory>",
                    f"<memory>\n{memory_str}\n</memory>",
                    full_prompt,
                    flags=re.DOTALL,
                )

            # 追加说话人信息
            try:
                current_speaker_name = (current_speaker or "").strip()
                # 仅在本轮注入了有效身份时才输出 speakers_info，避免列表里的名字每轮
                # 重复出现诱导模型反复称呼；后续轮不再注入身份，靠对话历史首轮保留
                if current_speaker_name and current_speaker_name != "未知说话人":
                    speakers = voiceprint_config.get("speakers", [])
                    speakers_info = "\n<speakers_info>"
                    speakers_info += f"\n当前说话人：{current_speaker_name}"
                    for speaker_str in speakers:
                        try:
                            parts = speaker_str.split(",", 2)
                            if len(parts) >= 2:
                                name = parts[1].strip()
                                description = (
                                    parts[2].strip() if len(parts) >= 3 else ""
                                )
                                speakers_info += f"\n- {name}：{description}"
                        except:
                            pass
                    speakers_info += "\n</speakers_info>"
                    full_prompt += speakers_info
            except:
                pass

            dialogue.append({"role": "system", "content": full_prompt})

        # 第二段：few-shot 示例（会话内不变）
        non_system_messages = [m for m in self.dialogue if m.role != "system"]
        fewshot_messages = [m for m in non_system_messages if m.is_temporary]
        complete_fewshot = self._ensure_tool_calls_complete(fewshot_messages)
        complete_fewshot = self._degrade_video(complete_fewshot, keep_video_turns)
        for m in complete_fewshot:
            self.getMessages(m, dialogue)

        # 第三段：实际对话历史（不含 few-shot）
        actual_messages = [m for m in non_system_messages if not m.is_temporary]
        complete_actual = self._ensure_tool_calls_complete(actual_messages)
        # 输出前做视频降级：只保留最近 keep_video_turns 轮的视频载荷
        complete_actual = self._degrade_video(complete_actual, keep_video_turns)
        for m in complete_actual:
            self.getMessages(m, dialogue)

        return dialogue
