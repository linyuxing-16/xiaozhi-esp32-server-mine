"""视频直入上下文：Message多模态 content 与 Dialogue 视频降级逻辑测试。"""
import pytest

from core.utils.dialogue import Dialogue, Message


def _video_part(b64="QUJD"):
    return {
        "type": "video_url",
        "video_url": {"url": "data:video/webm;base64," + b64},
    }


# ---------------------------------------------------------------------------
# Message 多模态字段
# ---------------------------------------------------------------------------

def test_message_accepts_list_content():
    content = [{"type": "text", "text": "看这个"}, _video_part()]
    m = Message(role="user", content=content, raw_text="看这个", has_video=True)
    assert m.content == content
    assert m.raw_text == "看这个"
    assert m.has_video is True


def test_message_str_content_defaults():
    """普通字符串消息：raw_text自动回退、has_video默认False（向后兼容）"""
    m = Message(role="user", content="你好")
    assert m.raw_text == "你好"
    assert m.has_video is False


def test_message_get_text_from_list_content():
    m = Message(
        role="user",
        content=[{"type": "text", "text": "看这个"}, _video_part()],
        raw_text="看这个",
        has_video=True,
    )
    assert m.get_text() == "看这个"


def test_message_get_text_without_raw_text_falls_back_to_segments():
    m = Message(
        role="user",
        content=[{"type": "text", "text": "甲"}, {"type": "text", "text": "乙"}],
    )
    assert m.get_text() == "甲乙"


def test_message_has_video_payload_static():
    assert Message.has_video_payload([_video_part()]) is True
    assert Message.has_video_payload([{"type": "text", "text": "x"}]) is False
    assert Message.has_video_payload("纯文本") is False
    assert Message.has_video_payload(None) is False


# ---------------------------------------------------------------------------
# get_llm_dialogue_with_memory 视频降级
# ---------------------------------------------------------------------------

def _build_dialogue_with_two_video_turns() -> Dialogue:
    d = Dialogue()
    d.update_system_message("你是助手")
    # 第一轮（旧）：带视频
    d.put(Message(
        role="user",
        content=[{"type": "text", "text": "第一轮"}, _video_part("QUJD")],
        raw_text="第一轮",
        has_video=True,
    ))
    d.put(Message(role="assistant", content="第一轮回复"))
    # 第二轮（新）：带视频
    d.put(Message(
        role="user",
        content=[{"type": "text", "text": "第二轮"}, _video_part("WFla")],
        raw_text="第二轮",
        has_video=True,
    ))
    d.put(Message(role="assistant", content="第二轮回复"))
    return d


def test_newest_video_turn_keeps_payload_older_degrades():
    d = _build_dialogue_with_two_video_turns()
    msgs = d.get_llm_dialogue_with_memory(keep_video_turns=1)
    user_msgs = [m for m in msgs if m["role"] == "user"]
    assert len(user_msgs) == 2
    # 旧轮次：降级为纯文本
    assert user_msgs[0]["content"] == "第一轮"
    # 新轮次：保留视频分片
    assert isinstance(user_msgs[1]["content"], list)
    assert any(
        seg.get("type") == "video_url" for seg in user_msgs[1]["content"]
    )


def test_degrade_does_not_mutate_stored_dialogue():
    d = _build_dialogue_with_two_video_turns()
    d.get_llm_dialogue_with_memory(keep_video_turns=1)
    # 存储层不变：两条用户消息仍是带视频的数组
    user_stored = [m for m in d.dialogue if m.role == "user"]
    assert all(isinstance(m.content, list) for m in user_stored)
    assert all(m.has_video for m in user_stored)


def test_keep_video_turns_zero_degrades_all():
    d = _build_dialogue_with_two_video_turns()
    msgs = d.get_llm_dialogue_with_memory(keep_video_turns=0)
    user_msgs = [m for m in msgs if m["role"] == "user"]
    assert all(isinstance(m["content"], str) for m in user_msgs)


def test_no_video_messages_output_unchanged():
    """enabled=false场景等价：没有视频时输出与现状一致"""
    d = Dialogue()
    d.update_system_message("你是助手")
    d.put(Message(role="user", content="你好"))
    d.put(Message(role="assistant", content="你好呀"))
    msgs = d.get_llm_dialogue_with_memory()
    assert {"role": "user", "content": "你好"} in msgs
    assert {"role": "assistant", "content": "你好呀"} in msgs


def test_release_stored_video_degrades_in_place():
    d = _build_dialogue_with_two_video_turns()
    d.release_stored_video(keep_turns=1)
    user_stored = [m for m in d.dialogue if m.role == "user"]
    # 旧轮：就地降级为纯文本
    assert user_stored[0].content == "第一轮"
    assert user_stored[0].has_video is False
    # 新轮：保留视频
    assert isinstance(user_stored[1].content, list)
    assert user_stored[1].has_video is True


# ---------------------------------------------------------------------------
# 工具调用链完整性不受多模态影响
# ---------------------------------------------------------------------------

def test_ensure_tool_calls_complete_unaffected_by_multimodal():
    d = Dialogue()
    d.put(Message(
        role="assistant",
        tool_calls=[{
            "id": "tc1",
            "function": {"name": "t", "arguments": "{}"},
            "type": "function",
        }],
    ))
    msgs = d.get_llm_dialogue()
    # 悬空tool_calls被补齐dummy tool消息
    tool_msgs = [m for m in msgs if m["role"] == "tool"]
    assert len(tool_msgs) == 1
