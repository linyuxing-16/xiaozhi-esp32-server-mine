from aiohttp import web
from config.logger import setup_logging


class BaseHandler:
    # 免鉴权测试客户端开关：仅显式配置后生效，默认关闭。
    # 历史上该旁路是硬编码的，任何人只要带上 Client-Id: web_test_client
    # 就能跳过 Bearer token 校验并伪造 Device-Id，故改为配置项控制。
    allow_test_client = False

    def __init__(self, config: dict):
        self.config = config
        self.logger = setup_logging()
        self.allow_test_client = self._read_allow_test_client(config)

    @staticmethod
    def _read_allow_test_client(config: dict) -> bool:
        """读取 allow_test_client 开关（支持顶层与 features 两处配置）"""
        if not isinstance(config, dict):
            return False
        if config.get("allow_test_client") is True:
            return True
        features = config.get("features") or {}
        if isinstance(features, dict) and features.get("allow_test_client") is True:
            return True
        return False

    def _is_allowed_test_client(self, client_id: str) -> bool:
        """判断是否命中免鉴权测试客户端（需配置显式开启）"""
        return bool(self.allow_test_client) and client_id == "web_test_client"

    def _add_cors_headers(self, response):
        """添加CORS头信息"""
        response.headers["Access-Control-Allow-Headers"] = (
            "client-id, content-type, device-id, authorization"
        )
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Origin"] = "*"

    async def handle_options(self, request):
        """处理OPTIONS请求，添加CORS头信息"""
        response = web.Response(body=b"", content_type="text/plain")
        self._add_cors_headers(response)
        # 添加允许的方法
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        return response
