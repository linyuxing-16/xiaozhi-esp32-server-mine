import os, json, uuid
from types import SimpleNamespace
from typing import Any, Dict, List

import requests
from google import generativeai as genai
from google.generativeai import types, GenerationConfig

from core.providers.llm.base import LLMProviderBase
from core.utils.util import check_model_key
from config.logger import setup_logging
from google.generativeai.types import GenerateContentResponse
from requests import RequestException

log = setup_logging()
TAG = __name__


def test_proxy(proxy_url: str, test_url: str) -> bool:
    try:
        resp = requests.get(test_url, proxies={"http": proxy_url, "https": proxy_url})
        return 200 <= resp.status_code < 400
    except RequestException:
        return False


def setup_proxy_env(http_proxy: str | None, https_proxy: str | None):
    """
    分别测试 HTTP 和 HTTPS 代理是否可用，并设置环境变量。
    如果 HTTPS 代理不可用但 HTTP 可用，会将 HTTPS_PROXY 也指向 HTTP。
    """
    test_http_url = "http://www.google.com"
    test_https_url = "https://www.google.com"

    ok_http = ok_https = False

    if http_proxy:
        ok_http = test_proxy(http_proxy, test_http_url)
        if ok_http:
            os.environ["HTTP_PROXY"] = http_proxy
            log.bind(tag=TAG).info(f"配置提供的Gemini HTTPS代理连通成功: {http_proxy}")
        else:
            log.bind(tag=TAG).warning(f"配置提供的Gemini HTTP代理不可用: {http_proxy}")

    if https_proxy:
        ok_https = test_proxy(https_proxy, test_https_url)
        if ok_https:
            os.environ["HTTPS_PROXY"] = https_proxy
            log.bind(tag=TAG).info(f"配置提供的Gemini HTTPS代理连通成功: {https_proxy}")
        else:
            log.bind(tag=TAG).warning(
                f"配置提供的Gemini HTTPS代理不可用: {https_proxy}"
            )

    # 如果https_proxy不可用，但http_proxy可用且能走通https，则复用http_proxy作为https_proxy
    if ok_http and not ok_https:
        if test_proxy(http_proxy, test_https_url):
            os.environ["HTTPS_PROXY"] = http_proxy
            ok_https = True
            log.bind(tag=TAG).info(f"复用HTTP代理作为HTTPS代理: {http_proxy}")

    if not ok_http and not ok_https:
        log.bind(tag=TAG).error(
            f"Gemini 代理设置失败: HTTP 和 HTTPS 代理都不可用，请检查配置"
        )
        raise RuntimeError("HTTP 和 HTTPS 代理都不可用，请检查配置")


class LLMProvider(LLMProviderBase):
    def __init__(self, cfg: Dict[str, Any]):
        self.model_name = cfg.get("model_name", "gemini-2.0-flash")
        self.api_key = cfg["api_key"]
        http_proxy = cfg.get("http_proxy")
        https_proxy = cfg.get("https_proxy")

        model_key_msg = check_model_key("LLM", self.api_key)
        if model_key_msg:
            log.bind(tag=TAG).error(model_key_msg)

        if http_proxy or https_proxy:
            log.bind(tag=TAG).info(
                f"检测到Gemini代理配置，开始测试代理连通性和设置代理环境..."
            )
            setup_proxy_env(http_proxy, https_proxy)
            log.bind(tag=TAG).info(
                f"Gemini 代理设置成功 - HTTP: {http_proxy}, HTTPS: {https_proxy}"
            )
        # 配置API密钥
        genai.configure(api_key=self.api_key)

        # 设置请求超时（秒）
        self.timeout = cfg.get("timeout", 120)  # 默认120秒

        # 创建模型实例
        self.model = genai.GenerativeModel(self.model_name)

        self.gen_cfg = GenerationConfig(
            temperature=0.7,
            top_p=0.9,
            top_k=40,
            max_output_tokens=2048,
        )

    @staticmethod
    def _build_tools(funcs: List[Dict[str, Any]] | None):
        if not funcs:
            return None
        return [
            types.Tool(
                function_declarations=[
                    types.FunctionDeclaration(
                        name=f["function"]["name"],
                        description=f["function"]["description"],
                        parameters=f["function"]["parameters"],
                    )
                    for f in funcs
                ]
            )
        ]

    # Gemini文档提到，无需维护session-id，直接用dialogue拼接而成
    def response(self, session_id, dialogue, **kwargs):
        yield from self._generate(dialogue, None)

    def response_with_functions(self, session_id, dialogue, functions=None):
        yield from self._generate(dialogue, self._build_tools(functions))

    @staticmethod
    def _build_part(seg) -> dict | None:
        """把OpenAI兼容的内容分片映射为Gemini parts条目。

        支持：text（文本）、video_url（视频，内联base64）、image_url（图片，内联base64）。
        data URL格式: data:<mime>;base64,<数据>
        """
        if not isinstance(seg, dict):
            return None
        seg_type = seg.get("type")
        if seg_type == "text":
            text = seg.get("text", "")
            if text:
                return {"text": str(text)}
            return None
        if seg_type in ("video_url", "image_url"):
            payload = seg.get(seg_type) or {}
            url = payload.get("url", "") if isinstance(payload, dict) else ""
            if not url:
                return None
            # mime兜底默认值：视频分片回退video/webm，图片分片回退image/jpeg
            default_mime = "video/webm" if seg_type == "video_url" else "image/jpeg"
            data = ""
            if url.startswith("data:"):
                # data:<mime>;base64,<data> —— mime从URI前缀解析
                # （如data:video/mp4;base64,... → video/mp4），解析失败回退默认值；
                # 统一小写并去除空白，避免上游Content-Type大小写差异
                header, _, data = url.partition(",")
                mime_type = header[5:].split(";")[0].strip().lower() or default_mime
            else:
                # http链接暂不内联，跳过（Gemini需要file_api上传，此处仅支持base64直传）
                return None
            inline = {"mime_type": mime_type, "data": data}
            # genai SDK 的 contents/parts 支持dict形式，inline_data自动映射为proto
            return {"inline_data": inline}
        return None

    @staticmethod
    def _build_parts_from_content(content) -> list:
        """content为分片数组时映射为Gemini parts；字符串时按纯文本处理"""
        parts: list = []
        if isinstance(content, list):
            for seg in content:
                part = LLMProvider._build_part(seg)
                if part is not None:
                    parts.append(part)
        else:
            text = str(content or "")
            if text:
                parts.append({"text": text})
        return parts

    def _generate(self, dialogue, tools):
        role_map = {"assistant": "model", "user": "user"}
        contents: list = []
        # 拼接对话
        for m in dialogue:
            r = m["role"]

            if r == "assistant" and "tool_calls" in m:
                tc = m["tool_calls"][0]
                contents.append(
                    {
                        "role": "model",
                        "parts": [
                            {
                                "function_call": {
                                    "name": tc["function"]["name"],
                                    "args": json.loads(tc["function"]["arguments"]),
                                }
                            }
                        ],
                    }
                )
                continue

            if r == "tool":
                contents.append(
                    {
                        "role": "model",
                        "parts": [{"text": str(m.get("content", ""))}],
                    }
                )
                continue

            # 多模态消息：content为分片数组（text/video_url/image_url）按类型映射
            contents.append(
                {
                    "role": role_map.get(r, "user"),
                    "parts": self._build_parts_from_content(m.get("content")),
                }
            )

        stream: GenerateContentResponse = self.model.generate_content(
            contents=contents,
            generation_config=self.gen_cfg,
            tools=tools,
            stream=True,
            timeout=self.timeout,
        )

        try:
            for chunk in stream:
                cand = chunk.candidates[0]
                for part in cand.content.parts:
                    # a) 函数调用-通常是最后一段话才是函数调用
                    if getattr(part, "function_call", None):
                        fc = part.function_call
                        yield None, [
                            SimpleNamespace(
                                id=uuid.uuid4().hex,
                                type="function",
                                function=SimpleNamespace(
                                    name=fc.name,
                                    arguments=json.dumps(
                                        dict(fc.args), ensure_ascii=False
                                    ),
                                ),
                            )
                        ]
                        return
                    # b) 普通文本
                    if getattr(part, "text", None):
                        yield part.text if tools is None else (part.text, None)

        finally:
            if tools is not None:
                yield None, None  # function‑mode 结束，返回哑包

    # 关闭stream，预留后续打断对话功能的功能方法，官方文档推荐打断对话要关闭上一个流，可以有效减少配额计费和资源占用
    @staticmethod
    def _safe_finish_stream(stream: GenerateContentResponse):
        if hasattr(stream, "resolve"):
            stream.resolve()  # Gemini SDK version ≥ 0.5.0
        elif hasattr(stream, "close"):
            stream.close()  # Gemini SDK version < 0.5.0
        else:
            for _ in stream:  # 兜底耗尽
                pass
