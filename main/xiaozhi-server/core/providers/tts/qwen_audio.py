import json
import requests

from config.logger import setup_logging
from core.utils.util import check_model_key
from core.providers.tts.base import TTSProviderBase

TAG = __name__
logger = setup_logging()


class TTSProvider(TTSProviderBase):
    """
    阿里云百炼 Qwen-Audio-TTS 系列（qwen-audio-3.1-tts-flash 等）
    走 DashScope HTTP 端点 /api/v1/services/audio/tts/SpeechSynthesizer
    文档: https://help.aliyun.com/zh/model-studio/qwen-tts
    """

    def __init__(self, config, delete_audio_file):
        super().__init__(config, delete_audio_file)
        self.api_key = config.get("api_key")
        self.api_url = config.get(
            "api_url",
            "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
        )
        self.model = config.get("model", "qwen-audio-3.1-tts-flash")
        if config.get("private_voice"):
            self.voice = config.get("private_voice")
        else:
            self.voice = config.get("voice", "longanhuan_v3.1")
        self.sample_rate = int(config.get("sample_rate", 24000))
        self.audio_file_type = config.get("format", "wav")

        model_key_msg = check_model_key("TTS", self.api_key)
        if model_key_msg:
            logger.bind(tag=TAG).error(model_key_msg)

    async def text_to_speak(self, text, output_file):
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        request_json = {
            "model": self.model,
            "input": {
                "text": text,
                "voice": self.voice,
                "format": self.audio_file_type,
                "sample_rate": self.sample_rate,
            },
        }
        response = requests.post(
            self.api_url,
            json=request_json,
            headers=headers,
            timeout=self.tts_timeout,
        )
        if response.status_code != 200:
            raise Exception(
                f"Qwen-Audio-TTS 请求失败: {response.status_code} {response.text[:300]}"
            )

        resp_json = response.json()
        audio_url = resp_json.get("output", {}).get("audio", {}).get("url")
        if not audio_url:
            raise Exception(f"Qwen-Audio-TTS 未返回音频URL: {str(resp_json)[:300]}")

        audio_resp = requests.get(audio_url, timeout=self.tts_timeout)
        if audio_resp.status_code != 200:
            raise Exception(
                f"下载合成音频失败: {audio_resp.status_code} {audio_resp.text[:200]}"
            )
        audio_data = audio_resp.content

        if output_file:
            with open(output_file, "wb") as f:
                f.write(audio_data)
        else:
            return audio_data
