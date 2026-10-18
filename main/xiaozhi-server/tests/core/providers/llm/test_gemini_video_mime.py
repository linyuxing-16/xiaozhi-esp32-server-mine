# -*- coding: utf-8 -*-
"""gemini LLM 视频分片 mime 解析测试（S3）。

video_url 分片的 mime 必须从 data URI 前缀解析
（如 data:video/mp4;base64,... → video/mp4；此前硬编码 video/webm 的隐患），
解析失败回退 video/webm；image_url 分片缺失 mime 时回退 image/jpeg。
"""
import pytest

gemini_module = pytest.importorskip(
    "core.providers.llm.gemini.gemini",
    reason="google-generativeai 未安装，跳过gemini mime测试",
)
LLMProvider = gemini_module.LLMProvider


def _video_seg(url: str) -> dict:
    return {"type": "video_url", "video_url": {"url": url}}


def _image_seg(url: str) -> dict:
    return {"type": "image_url", "image_url": {"url": url}}


def test_mp4_data_uri_maps_mime():
    part = LLMProvider._build_part(_video_seg("data:video/mp4;base64,QUJD"))
    assert part == {"inline_data": {"mime_type": "video/mp4", "data": "QUJD"}}


def test_webm_data_uri_maps_mime():
    part = LLMProvider._build_part(_video_seg("data:video/webm;base64,QUJD"))
    assert part == {"inline_data": {"mime_type": "video/webm", "data": "QUJD"}}


def test_missing_mime_falls_back_to_webm():
    part = LLMProvider._build_part(_video_seg("data:;base64,QUJD"))
    assert part["inline_data"]["mime_type"] == "video/webm"
    assert part["inline_data"]["data"] == "QUJD"


def test_mime_case_normalized():
    part = LLMProvider._build_part(_video_seg("data:VIDEO/MP4;base64,QUJD"))
    assert part["inline_data"]["mime_type"] == "video/mp4"


def test_image_png_data_uri_maps_mime():
    part = LLMProvider._build_part(_image_seg("data:image/png;base64,QUJD"))
    assert part == {"inline_data": {"mime_type": "image/png", "data": "QUJD"}}


def test_image_missing_mime_falls_back_to_jpeg():
    part = LLMProvider._build_part(_image_seg("data:;base64,QUJD"))
    assert part["inline_data"]["mime_type"] == "image/jpeg"


def test_non_data_url_skipped():
    # http链接暂不内联（Gemini需file_api上传），跳过
    assert LLMProvider._build_part(_video_seg("http://example.com/a.mp4")) is None


def test_empty_url_skipped():
    assert LLMProvider._build_part(_video_seg("")) is None
