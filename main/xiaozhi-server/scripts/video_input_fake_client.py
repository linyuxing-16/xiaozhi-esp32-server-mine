# -*- coding: utf-8 -*-
"""VAD触发录像 假客户端联调脚本。

模拟一个支持camera命令的客户端，完整走一遍服务端状态机：
  1. 建立WebSocket连接并发送hello
  2. 发送 listen start（触发服务端trigger_on_listen_start录像逻辑）
  3. 收到 camera start_record → 回执 record_started
  4. 收到 camera stop_record → 用假视频字节(webm魔数)上传 /mcp/vision/video
  5. 打印全程状态流转，用于验收"录像编排器"行为

用法（在能连通服务端的机器上）：
  python scripts/video_input_fake_client.py --ws ws://127.0.0.1:8000/xiaozhi/v1/ \
      --http http://127.0.0.1:8003 --device-id test_device

依赖：pip install websockets requests
"""
import argparse
import asyncio
import json
import time
import uuid

import requests
import websockets

TAG = "FakeVideoClient"

# 假视频字节：EBML魔数开头（服务端魔数白名单通过）
FAKE_WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 2048


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


async def run(ws_url: str, http_url: str, device_id: str, hold_ms: int):
    headers = {
        "device-id": device_id,
        "client-id": "web_test_client",
    }
    log("连接 %s" % ws_url)
    async with websockets.connect(ws_url, additional_headers=headers) as ws:
        hello = {
            "type": "hello",
            "version": 1,
            "features": {"mcp": True},
            "audio_params": {
                "format": "opus", "sample_rate": 24000,
                "channels": 1, "frame_duration": 60,
            },
        }
        await ws.send(json.dumps(hello))
        log("已发送hello，等待服务端回应...")

        request_id = None
        start_record_at = None

        # 后台任务：模拟用户说话（listen start → 等待 → listen stop）
        async def speak_later():
            await asyncio.sleep(1.5)
            await ws.send(json.dumps({"type": "listen", "state": "start", "mode": "auto"}))
            log("已发送 listen start（模拟用户开始说话，服务端应触发录像）")
            await asyncio.sleep(hold_ms / 1000.0)
            await ws.send(json.dumps({"type": "listen", "state": "stop"}))
            log("已发送 listen stop（模拟用户停止说话，服务端应下发stop_record）")

        speaker = asyncio.create_task(speak_later())

        try:
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=30)
                if isinstance(raw, bytes):
                    continue  # 音频流，忽略
                msg = json.loads(raw)

                if msg.get("type") == "hello":
                    log("握手成功 session_id=%s" % msg.get("session_id"))
                    continue

                if msg.get("type") == "camera":
                    command = msg.get("command")
                    if command == "start_record":
                        request_id = msg.get("request_id")
                        start_record_at = time.monotonic()
                        log("<< 收到 start_record request_id=%s max=%sms"
                            % (request_id, msg.get("max_duration_ms")))
                        await ws.send(json.dumps({
                            "type": "camera",
                            "command": "record_started",
                            "request_id": request_id,
                        }))
                        log(">> 已回执 record_started")
                    elif command == "stop_record":
                        log("<< 收到 stop_record request_id=%s" % msg.get("request_id"))
                        # 模拟录像编码耗时后上传
                        await asyncio.sleep(0.2)
                        url = http_url.rstrip("/") + "/mcp/vision/video"
                        files = {"video": ("record.webm", FAKE_WEBM, "video/webm")}
                        data = {"request_id": msg.get("request_id") or request_id}
                        resp = requests.post(
                            url, files=files, data=data, headers={
                                "Device-Id": device_id,
                                "Client-Id": "web_test_client",
                                "Authorization": "Bearer dummy",
                            }, timeout=10,
                        )
                        log(">> 上传视频 %s → HTTP %s %s"
                            % (url, resp.status_code, resp.text[:120]))
                        log("录像-上传总耗时: %.0fms"
                            % ((time.monotonic() - start_record_at) * 1000))
                    else:
                        log("<< 未知camera命令: %s" % command)
                    continue

                log("<< %s: %s" % (msg.get("type"), json.dumps(msg, ensure_ascii=False)[:120]))
        except asyncio.TimeoutError:
            log("等待消息超时（若已看到上传成功日志即验收通过）")
        finally:
            speaker.cancel()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ws", default="ws://127.0.0.1:8000/xiaozhi/v1/")
    parser.add_argument("--http", default="http://127.0.0.1:8003")
    parser.add_argument("--device-id", default="test_device")
    parser.add_argument("--hold-ms", type=int, default=2000, help="模拟说话时长")
    args = parser.parse_args()
    asyncio.run(run(args.ws, args.http, args.device_id, args.hold_ms))


if __name__ == "__main__":
    main()
