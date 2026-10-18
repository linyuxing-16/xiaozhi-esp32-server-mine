# VAD 触发摄像头录像并直入大模型上下文 —— 实施计划

> 目标一句话：**当 VAD（Voice Activity Detection，语音活动检测）检测到有语音活动、且当前 LLM（Large Language Model，大语言模型）支持视频输入时，让客户端用摄像头录一段视频，并把这段视频"直接"作为多模态内容加进本轮对话上下文**（不做"先让视觉模型转文字再进上下文"的间接路径）。
>
> 文档版本：v1.0（待审核稿）｜写作日期：2025（本仓库工作区自动生成）

---

## 1. 背景与需求

### 1.1 需求描述（原始诉求）
- 触发条件一：VAD 检测到有语音活动；
- 触发条件二：当前选用的 LLM 支持视频输入；
- 动作：使用**客户端**的摄像头录像；
- 结果：把录像**直接添加**进对话上下文（multimodal，多模态直传，而非先由视觉模型转成文字描述）。

### 1.2 与现有"拍照识物"功能的区别
| 对比项 | 现有 MCP Vision（拍照识物） | 本需求 |
| --- | --- | --- |
| 触发方式 | 用户主动说"看看这是什么"→ LLM 调用工具 self_camera_take_photo（自拍摄像头拍照） | VAD 一检测到说话就自动触发 |
| 媒体类型 | 单帧 JPEG（图片） | 视频片段（webm/mp4 或帧序列）；服务端额外支持 ESP32 固件封装的 AVI(MJPG) 上传并自动转码为 MP4（v1.1 起，见 docs/video-input-avi-mjpeg-support-plan.md） |
| 消费方式 | 交给独立的 VLLM（视觉语言模型）模块生成**文字描述**，工具结果回到主 LLM | **直接**把视频本体放进主 LLM 的 messages（消息列表）里 |
| 上下文 | 不进历史 | 进入对话历史（需管理生命周期，防止 token 爆炸） |

### 1.3 范围界定
- **本期（M1~M5）**：xiaozhi-server（小智服务端，Python）+ digital-human（数字人网页客户端，浏览器）全链路打通；协议对 ESP32 固件保持兼容预留。
- **暂不做（P2）**：ESP32 固件内录像（MCU 内存受限，需固件仓库单独排期）、智控台（manager-api（管理后台Java服务）/ manager-web（管理网页））界面支持、聊天历史存档视频。

---

## 2. 现状梳理（关键代码位置）

### 2.1 音频→对话 主链路
| 环节 | 位置 | 说明 |
| --- | --- | --- |
| VAD 判定入口 | main/xiaozhi-server/core/handle/receiveAudioHandle.py 17行 handleAudioMessage（处理音频消息） | 每个音频帧调用 conn.vad.is_vad（是否有人声） |
| VAD 实现 | main/xiaozhi-server/core/providers/vad/silero.py（SileroVAD） | is_vad 内部维护 conn.client_have_voice（客户端是否在说话）、conn.client_voice_stop（本轮说话是否结束）、conn.vad_last_voice_time |
| 语音停止→识别 | main/xiaozhi-server/core/providers/asr/base.py 61行 receive_audio（接收音频）、84行 handle_voice_stop（处理语音停止） | 说话结束后做 ASR（Automatic Speech Recognition，语音识别），随后调 startToChat（开始聊天） |
| 聊天入口 | main/xiaozhi-server/core/handle/receiveAudioHandle.py 43行 startToChat | 先做意图识别 handle_user_intent（处理用户意图，纯文本），再 conn.chat(text) |
| 用户消息入上下文 | main/xiaozhi-server/core/connection.py 1055行 chat()；1066行 self.dialogue.put(Message(role="user", content=query)) | **本需求的核心注入点** |
| 对话容器 | main/xiaozhi-server/core/utils/dialogue.py Message（消息）/ Dialogue（对话） | Message.content 目前**只支持字符串**；get_llm_dialogue_with_memory（生成给大模型的对话）原样输出 {"role","content"} |
| OpenAI 兼容 LLM | main/xiaozhi-server/core/providers/llm/openai/openai.py 92行 response() | dialogue 直接透传给 openai SDK——**content 若是数组天然可透传**（多模态改造的关键便利点） |
| Gemini LLM | main/xiaozhi-server/core/providers/llm/gemini/gemini.py 128行 _generate() | 自己拼 parts（内容分片），目前只拼 {"text": 字符串}，需扩展 |
| 客户端消息 | main/xiaozhi-server/core/handle/textHandler/listenMessageHandler.py | 处理 listen（监听）消息：state=start/stop/detect；start 表示**设备本地 VAD**也报告了"用户开始说话" |

### 2.2 现有视觉链路（可复用的样板）
| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 视觉描述注入 | main/xiaozhi-server/core/providers/tools/device_mcp/mcp_handler.py 238~261行 send_mcp_initialize_message（发送MCP初始化消息） | MCP（Model Context Protocol，模型上下文协议）initialize（初始化）时向设备下发 capabilities.vision = { url（视觉分析接口地址）, token（鉴权令牌） } |
| 图片上传接口 | main/xiaozhi-server/core/api/vision_handler.py | POST /mcp/vision/explain（视觉解释）：AuthToken（鉴权令牌工具）校验 Bearer token + Device-Id（设备ID）一致性 + 5MB 大小限制 + multipart/form-data（多部分表单）解析 —— **视频上传接口直接照抄这套鉴权** |
| HTTP 服务注册 | main/xiaozhi-server/core/http_server.py 68~73行 | 新路由在此注册 |
| 网页客户端摄像头 | main/digital-human/js/app.js 190~238行 startCamera/stopCamera | getUserMedia（获取媒体流）拿 cameraStream（摄像头流），视频 180x240、无音频 |
| 网页客户端拍照上传 | main/digital-human/js/app.js 266~345行 takePhoto（拍照） | canvas 截帧→FormData 上传→fetch（浏览器请求）带 Device-Id/Client-Id/Authorization —— **上传代码可仿写** |
| 网页端 MCP 拍照工具 | main/digital-human/js/core/mcp/tools.js 487行 self_camera_take_photo（自拍摄像头拍照） | 工具名映射到 window.takePhoto |
| 网页端消息分发 | main/digital-human/js/core/network/websocket.js 55~162行 | 按 message.type（消息类型）分发：hello/tts/audio/stt/llm/mcp，**需新增 camera 类型** |
| 配置文件 | main/xiaozhi-server/config.yaml | selected_module（选定模块）/ LLM / VLLM（视觉语言模型）各节；模块初始化在 core/utils/modules_initialize.py |

### 2.3 差距分析（要补什么）
1. **没有"LLM 是否支持视频输入"的能力声明**——配置里无从表达，服务端也无从判断。
2. **Message/Dialogue 不支持多模态 content**（内容分片数组），历史消息、记忆、上报等处假设 content 是字符串。
3. **没有录像触发编排**：VAD 上升沿（人声从无到有）没有钩子；也没有"等视频上传再聊天"的等待/超时机制。
4. **没有视频上传接口**：现有 /mcp/vision/explain 只收图片且结果不进上下文。
5. **网页客户端没有 MediaRecorder（媒体录制器）录像与上传**，也没有响应服务端 camera（摄像头）命令的通道。
6. **视频进上下文后的生命周期管理**缺失：历史轮次会反复携带大 base64（基底64编码）载荷，必须做"旧轮次降级"。

---

## 3. 总体设计

### 3.1 触发条件（服务端统一判定）
在 conn（连接对象，ConnectionHandler 实例）上新增一个 VideoInputController（视频输入控制器）状态机，触发录像需同时满足：

| # | 条件 | 判定位置 |
| --- | --- | --- |
| C1 | 功能总开关开启 features.video_input.enabled（默认 false，隐私考虑） | 配置读取 |
| C2 | 当前 LLM 支持视频输入，即所配 LLM 的 video_input（视频输入）配置 != none | 模块初始化时读取，存为 conn.llm_video_mode（连接级视频模式） |
| C3 | VAD 检测到语音活动（上升沿） | handleAudioMessage 里调用 is_vad **之前**快照 conn.client_have_voice，调用后对比得到 False→True；同时兼容 listen 消息 state=start（客户端本地 VAD 上报） |
| C4 | 防抖：距上次录像 > cooldown_ms（冷却时间）；不在 just_woken_up（刚唤醒抑制期）内；client_listen_mode（客户端拾音模式）非 manual（手动） | 编排器内部 |

### 3.2 端到端时序（正常路径）

```
客户端(浏览器/设备)                     服务端(xiaozhi-server)
      │  音频流 opus ──────────────────────▶ handleAudioMessage
      │                                        │ VAD 上升沿(C1~C4通过)
      │                                        │ 创建 CaptureSession（录像会话）
      │ ◀──── ws: {"type":"camera",            │
      │        "command":"start_record",       │
      │        "request_id":r1,                │
      │        "max_duration_ms":5000}         │
      │ MediaRecorder 开始录像                  │
      │        （用户继续说话…）                 │ ASR 并行识别中…
      │  VAD 下降沿 / listen stop ────────────▶│
      │ ◀──── ws: {"type":"camera",            │
      │        "command":"stop_record",        │
      │        "request_id":"r1"}              │
      │ 停止录像得到 Blob（二进制大对象）          │
      │ ════ HTTP POST multipart ════════════▶│ VideoHandler(视频上传接口)
      │   /mcp/vision/video  (request_id=r1)   │ 校验token/大小→存临时文件→投递给conn
      │                                        │
      │                                        │ handle_voice_stop → startToChat
      │                                        │ chat(query): 等待视频到达(带超时,
      │                                        │ 默认6s，通常已到达)
      │                                        │ 组装多模态用户消息:
      │                                        │ content=[{"type":"text",...},
      │                                        │   {"type":"video_url",...}]
      │                                        │ dialogue.put(...) → LLM 流式回复
      │ ◀──── tts 音频流 ───────────────────────│ 回复完成后视频字节按策略降级/删除
```

要点：**录像与 ASR 并行**，视频上传通常在 ASR 完成前就绪，额外延迟≈0；若 chat 时视频未到，最多等 upload_wait_timeout_ms（上传等待超时），超时则纯文本回复并在日志记录原因。

### 3.3 "直接添加进上下文"的消息格式

用户消息 content（内容）从字符串升级为 OpenAI 兼容的**分片数组**（也兼容纯文本字符串，两者并存）：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "（本轮ASR识别文本）" },
    { "type": "video_url",
      "video_url": { "url": "data:video/webm;base64,<视频base64>" } }
  ]
}
```

各 LLM 供应商适配方式（由 3.1-C2 的 video_input 模式决定）：
- **native（原生直传）**：openai 兼容供应商 response() 原样透传数组（天然支持，无需改动消息构造）；gemini 供应商在 _generate() 里把 video_url 分片映射为 inline_data（内联数据）{mime_type: "video/webm", data: base64}。适用于 Gemini 等真正支持视频输入的模型。
- **none（不支持）**：功能对该 LLM 完全关闭，行为与现状一致。

### 3.4 视频在上下文中的生命周期（防 token 爆炸，关键）
- Message 增加两个字段：raw_text（本轮纯文本，供记忆/上报/降级后使用）与 has_video（是否携带视频载荷）。
- Dialogue.get_llm_dialogue_with_memory（生成给大模型的对话）输出前执行 degrade（降级）：只保留**最近 keep_video_turns（保留视频轮数，默认 1）**轮的视频分片，更早轮次的 content 还原为 raw_text 纯文本（视频 base64 字节在回合结束、TTS（Text To Speech，语音合成）完成后即从内存释放）。
- 记忆模块 query_memory（记忆查询）、意图识别 handle_user_intent（处理用户意图，纯文本）、聊天历史上报 enqueue_asr_report（ASR上报队列）全部继续用 raw_text，**不受多模态影响**。

---

## 4. 详细改动清单

### 4.1 服务端（main/xiaozhi-server）

| 文件 | 改动 |
| --- | --- |
| core/utils/dialogue.py | ① Message 构造允许 content 为 str 或 list，新增 raw_text、has_video 字段；② getMessages（组装单条消息）原样输出 content（str/list 都直接给）；③ 新增 _degrade_video(keep_turns) 在 get_llm_dialogue_with_memory 输出前做旧轮降级；④ 注意 _ensure_tool_calls_complete（补全工具调用）不受影响 |
| core/connection.py | ① chat() 1055行：depth==0 分支组装用户 Message 时，调用 video 控制器 take_pending_video(query)（取走待用视频），有视频且 C2 通过则构造分片数组 content；② __init__/close 处挂载与清理 VideoInputController；③ 新增属性 llm_video_mode |
| 新增 core/handle/videoInputController.py | 录像编排状态机：on_vad_speech_start（人声开始）、on_vad_speech_stop（人声结束）、deliver_upload（接收上传投递）、take_pending_video（取走待用视频）、超时定时器、冷却时间、会话生命周期与临时文件清理 |
| core/handle/receiveAudioHandle.py | handleAudioMessage 中，在 have_voice = conn.vad.is_vad(...)（19行）前后做上升沿检测，触发 conn.video.on_vad_speech_start()（非阻塞 asyncio.create_task（异步任务）） |
| core/providers/asr/base.py 或 listenMessageHandler.py | 语音停止处（handle_voice_stop / listen state=stop）触发 conn.video.on_vad_speech_stop()；listen state=start（55行 detect 之外）也作为可选触发点 trigger_on_listen_start |
| 新增 core/api/video_handler.py | POST /mcp/vision/video（视频上传）：完全仿照 vision_handler.py——AuthToken 校验 Bearer token、Device-Id/Client-Id 一致性校验、multipart 读取 request_id 与 video 字段、大小/时长白名单校验、落盘 tmp/videos（临时目录）、按 Device-Id 找活跃连接投递 |
| core/http_server.py | 注册路由：web.post("/mcp/vision/video", self.video_handler.handle_post)；同步在 app.py 启动日志中打印"视频上传接口是 http://…/mcp/vision/video" |
| core/providers/tools/device_mcp/mcp_handler.py | send_mcp_initialize_message 的 capabilities.vision 增加 video_url（视频上传地址，与 url 同源）字段，向后兼容（老固件忽略） |
| core/providers/llm/openai/openai.py | normalize_dialogue（对话规范化）对 list 类型 content 不做处理直接放行；确认 response/response_with_functions 透传（预计零逻辑改动，仅加防御） |
| core/providers/llm/gemini/gemini.py | _generate() 128~166行：content 为 list 时按分片类型映射：text→{"text"}、video_url→{"inline_data":{"mime_type","data"}}、image_url→{"inline_data"} |
| core/utils/modules_initialize.py | 初始化 LLM 后读取其配置里的 video_input/video_input_params 存到实例属性；日志打印视频能力 |
| config/config_loader.py | 透传新配置节 features（功能） |
| config/config.yaml | 新增 features.video_input 节（见 §6）；LLM 各示例条目加注释示例 |
| app.py | 启动日志增加视频上传接口地址 |

### 4.2 客户端（main/digital-human，网页端先行）

| 文件 | 改动 |
| --- | --- |
| js/app.js | ① startCamera 的 video 约束从 180x240 提升（如 640x480，可在设置里二选一，兼顾带宽）；② 新增 window.recordVideo({requestId, maxDurationMs})：基于现有 this.cameraStream（摄像头流）+ MediaRecorder（媒体录制器，video/webm;codecs=vp8，Safari 回退 mp4），录制中在浮窗上显示红点提示（隐私）；返回 Promise<Blob>；③ 新增 uploadVideoBlob(blob, requestId)：FormData 上传到视觉配置中的 video_url（localStorage 键 xz_tester_vision 扩展字段），带 Device-Id/Client-Id/Authorization |
| js/core/network/websocket.js | 消息分发（55~162行）新增 message.type === 'camera'（摄像头）分支：command=start_record → 调 recordVideo；command=stop_record → 提前停止并触发 uploadVideoBlob；断线时清理未完成会话 |
| js/core/mcp/tools.js | （可选）预留 self_camera_record_video（自拍摄像头录像）工具映射，便于纯工具触发模式复用 |

### 4.3 ESP32 设备（协议预留，本期不实现固件）
- 服务端 ws 命令与 HTTP 上传协议对固件透明可用；固件侧后续可仿 take_photo 实现 start/stop/上传（MCU 建议 JPEG 帧序列：每帧一个 part（分部字段）或按 request_id 多次上传，服务端合并）。
- 本期服务端对不支持 camera 命令的客户端**静默降级**（下发后 1 秒内无 ack（确认）即放弃本轮录像，不影响语音对话）。

---

## 5. 协议定义

### 5.1 WebSocket 服务端→客户端命令
```json
{"type":"camera","command":"start_record","request_id":"<uuid>","max_duration_ms":5000}
{"type":"camera","command":"stop_record","request_id":"<uuid>"}
```
客户端可选回执（1 秒超时即视为不支持）：
```json
{"type":"camera","command":"record_started","request_id":"<uuid>"}
```

### 5.2 HTTP 视频上传
- POST /mcp/vision/video（与 /mcp/vision/explain 同端口，默认 8003）
- Headers（请求头）：Device-Id、Client-Id、Authorization: Bearer <token>（token 与 vision 下发的同一个）
- Body：multipart/form-data：request_id（字符串）、video（文件，webm/mp4；v1.1 起亦支持 ESP32 固件的 AVI(MJPG)，服务端自动转码为 MP4 后入上下文）
- 限制：≤max_file_mb（默认25MB）、时长≤max_duration_ms、content-type（内容类型）白名单
- 返回：{"success":true}；错误码 401（鉴权失败）/404（无活跃会话）/413（超大）/415（格式）

---

## 6. 配置样例（config.yaml）

```yaml
# 新增节：功能开关
features:
  video_input:                  # VAD触发录像直入上下文
    enabled: true               # 总开关（默认 false，审核后按需打开）
    trigger_on_vad: true        # 服务端VAD人声上升沿触发
    trigger_on_listen_start: true  # 客户端本地VAD(listen start)也触发
    cooldown_ms: 8000           # 两次录像最小间隔
    max_duration_ms: 5000       # 单段最长录制
    min_duration_ms: 800        # 短于此丢弃（防误触）
    upload_wait_timeout_ms: 6000   # chat 时等待视频上传的最长时间
    max_file_mb: 25
    keep_video_turns: 1         # 上下文中保留视频载荷的最近轮数
    tmp_dir: tmp/videos         # 上传临时目录（用后即删）

# LLM 节新增可选字段（示例）：
LLM:
  GeminiLLM:
    type: gemini
    model_name: "gemini-2.0-flash"
    api_key: 你的gemini web key
    video_input: native         # native=视频直传 / none=不支持(默认)
  ChatGLMLLM:
    type: openai
    model_name: glm-4-flash
    url: https://open.bigmodel.cn/api/paas/v4/
    api_key: 你的chat-glm web key
    # video_input: none        # 文本模型无需配置，默认 none
```

---

## 7. 关键技术点与风险

| 风险/难点 | 对策 |
| --- | --- |
| OpenAI 兼容接口多数**不认 video_url**，只认 image_url | video_input 二态设计（native/none） |
| 视频 base64 在历史中反复发送 → token 爆炸 | keep_video_turns 降级 + 回合结束即释放字节；只保留 raw_text |
| 自动录像的**隐私问题** | 默认 enabled:false；客户端录制中有显式红点提示；文档中显著说明；设备绑定+Bearer 鉴权防滥用 |
| 上传慢于 ASR → 阻塞回复 | upload_wait_timeout_ms（默认6s）上限；超时走纯文本；录像与 ASR 并行已覆盖绝大多数场景 |
| 用户连续说话/抢话（打断） | 同一 CaptureSession 复用（stop 前 start 忽略重复触发）；handleAbortMessage（处理打断消息）时取消等待中的上传等待 |
| 意图识别/记忆拿到多模态消息报错 | 这些路径一律使用 raw_text（已在 3.4 隔离） |
| 旧客户端不认识 camera 命令 | 下发后等 ack 1 秒，无回执静默放弃，零影响 |
| 磁盘/内存 | 上传限大小、落 tmp 目录、回合结束即删、conn.close()（连接关闭）时兜底清理 |

---

## 8. 里程碑与验收标准

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M1（约0.5天） | 能力声明 + Message/Dialogue 多模态改造 + 降级逻辑（纯服务端） | 单测：get_llm_dialogue 对含视频消息的输出/降级正确；enabled=false 时输出与现状逐字节一致 |
| M2（约1天） | 录像编排器 + 上传接口 + VAD/listen 触发钩子 | 假客户端脚本（python aiohttp（异步HTTP框架））模拟 ws+上传，日志可见完整状态机流转 |
| M3（约1天） | digital-human 录制/上传/红点提示/ws 分发 | 浏览器实测：说话即录、停即传，"摄像头未开"时静默降级 |
| M4（约0.5天） | gemini native 透传（frames 抽帧模式经确认不做，video_input 仅 native/none 两态） | Gemini 全链路出图生回答 |
| M5（约0.5天） | 联调、回归、文档（含本计划的落地说明） | 全量回归：VAD/打断/唤醒词/manual 模式/断线重连无回归 |
| P2（可选） | 智控台字段、ESP32 固件、聊天历史存视频引用 | 另行排期 |

---

## 9. 测试计划
1. **单元测试**（tests/（测试目录））：dialogue 降级、Message list content 组装、video_handler 鉴权 401/413/415、控制器状态机（冷却/超时/重复触发）。
2. **集成测试**：GeminiLLM(video_input: native) + digital-human 全链路。
3. **回归开关**：features.video_input.enabled=false 时与 main 分支行为一致（重点回归：普通语音对话、打断、唤醒词、manual 模式、记忆、聊天历史上报）。
4. **性能观测**：日志输出"视频到达等待耗时"，目标 P95（95分位）≤ 500ms 额外延迟。

---

## 10. 留给明日审核的确认点
1. **录制窗口策略**：本计划采用"语音开始→开始录，语音结束→停止，封顶 5 秒"。是否希望改为"固定时长（如 3 秒）短视频"？
2. **触发粒度**：每段人声都录（有冷却 8 秒），还是仅当 ASR 文本非唤醒词时才补录（视频会晚一拍）？
3. **隐私默认值**：enabled 默认 false（需手动开启）是否符合预期？
4. **是否需要把录像同时存档**到聊天历史/管理后台（当前计划仅临时使用，用后即删）？
5. **ESP32 端形态**：固件走"视频"还是"JPEG 帧序列"？影响后续固件排期（本仓库只定协议）。

---

## 11. 落地实施记录（v1.0 已实现）

本节为计划落地后的实施说明，对应里程碑 M1~M5。

### 11.1 实际改动清单

**服务端（main/xiaozhi-server）**

| 文件 | 改动 |
| --- | --- |
| config.yaml | 新增顶层 features.video_input 节（§6 所有字段，enabled 默认 false） |
| core/utils/dialogue.py | Message 支持 content 为 str 或 list（新增 raw_text/has_video 字段与 get_text()/has_video_payload() 方法）；新增 _degrade_video()（输出前降级，不动存储层）、release_stored_video()（回合结束就地释放旧轮次视频字节）；get_llm_dialogue_with_memory 新增 keep_video_turns 参数 |
| core/utils/modules_initialize.py | 初始化 LLM 时读取 video_input 配置（native/none，非法值回退 none），挂到 llm 实例属性并打印能力日志 |
| core/connection.py | 新增类级活跃连接注册表（register_active/unregister_active/get_active_by_device，视频上传接口按 device-id 投递）；__init__ 挂载 VideoInputController；新增 llm_video_mode 属性；chat() depth==0 时 take_pending_video() 取视频组装 text+video_url 分片数组（raw_text=query, has_video=True），回合结束与 LLM 异常路径调用 release_stored_video；close() 清理控制器并注销注册表 |
| core/handle/videoInputController.py | **新增**。录像编排状态机：on_speech_start/on_speech_stop/on_abort/deliver_upload/handle_ack/take_pending_video/read_video_as_part/close；ack 1 秒看门狗（超时判定客户端不支持，之后立即放弃不等待）、最长录制看门狗、冷却防抖、会话复用 |
| core/handle/receiveAudioHandle.py | handleAudioMessage 在 is_vad 前后快照 client_have_voice，检测 False→True 上升沿触发 on_speech_start("vad") |
| core/providers/asr/base.py | handle_voice_stop 开头触发 on_speech_stop |
| core/handle/textHandler/listenMessageHandler.py | listen state=start 触发 on_speech_start("listen")；state=stop 触发 on_speech_stop |
| core/handle/abortHandle.py | 打断时 on_abort()（停录像 + 取消等待） |
| core/api/video_handler.py | **新增**。POST /mcp/vision/video：AuthToken 校验（与 vision explain 同套）、Device-Id 一致性、multipart 解析 request_id+video、大小上限（413）、魔数+Content-Type 白名单（415）、无活跃会话 404、落盘 tmp/videos 后 deliver_upload |
| core/http_server.py | 注册 /mcp/vision/video 路由（GET 探活 + POST） |
| core/providers/tools/device_mcp/mcp_handler.py | capabilities.vision 增加 video_url 字段（vision_url 路径替换生成），老固件忽略 |
| core/providers/memory/*（mem_local_short/powermem/mem0ai） | msg.content 改为 msg.get_text()，多模态消息走纯文本 |
| core/providers/llm/openai/openai.py | normalize_dialogue 注释明确 list content 原样放行（天然透传） |
| core/providers/llm/gemini/gemini.py | _generate() 内容分片映射：text→{"text"}、video_url/image_url→{"inline_data":{mime_type,data}}（仅支持 data URL 直传） |
| app.py | 启动日志增加视频上传接口地址 |

**客户端（main/digital-human）**

| 文件 | 改动 |
| --- | --- |
| js/app.js | 新增 window.recordVideo（MediaRecorder，vp9/vp8/webm→mp4 回退，红点 REC 角标提示，500ms 分片，最长时长自动停，<800ms 丢弃）、window.stopVideoRecording、window.uploadVideoBlob（读 localStorage xz_tester_vision 的 video_url 字段，旧配置从 url 推导；FormData 带 Device-Id/Client-Id/Authorization）；stopCamera/断线时中止录像 |
| js/core/network/websocket.js | handleTextMessage 新增 camera 分支；handleCameraMessage 处理 start_record（调 recordVideo→上传）与 stop_record；监听 video-recording-started 事件回执 record_started；onclose 清理会话 |
| js/core/mcp/tools.js | 预留 self_camera_record_video 工具执行映射 |
| index.html + js/*.js | 模块缓存版本号 v=0205 → v=0206 |

**协议（与 §5 一致，实测字段）**

- WS 下发：{"type":"camera","command":"start_record","request_id":"<uuid>","max_duration_ms":5000} / {"type":"camera","command":"stop_record","request_id":"<uuid>"}
- WS 回执：{"type":"camera","command":"record_started","request_id":"<uuid>"}（1 秒未回执 → 判定不支持，之后本轮及后续均静默跳过）
- HTTP：POST /mcp/vision/video，multipart 字段 request_id + video，鉴权头与 vision explain 相同

### 11.2 测试与验证

| 项 | 结果 |
| --- | --- |
| tests/core/utils/test_dialogue_video.py（11 用例：多模态 Message、降级、轮数控制、无视频逐字节兼容） | ✅ 通过 |
| tests/core/handle/test_video_input_controller.py（18 用例：触发条件/冷却/ack/投递/取用/超时/打断/清理） | ✅ 通过 |
| tests/core/api/test_video_handler_http.py（6 用例：真实 aiohttp 服务，200/401/404/413/415 与投递全流程） | ✅ 通过 |
| tests/core/utils/test_dialogue.py 等既有回归 | ✅ 通过（58/58 全绿） |
| 全部改动文件 py_compile / node --check | ✅ 通过 |
| 假客户端联调脚本 scripts/video_input_fake_client.py | ✅ 语法通过；需在能连通服务端的环境执行（见脚本头注释） |

### 11.3 已知边界与遗留（P2）

1. **真机浏览器全链路**（M3 验收的"说话即录、停即传"）与 **Gemini 实钥全链路**（M4 验收）需要真实摄像头与 API key，请在联调环境按 §11.1 配置开启后用 scripts/video_input_fake_client.py 或 digital-human 页面验证。
2. OpenAI 兼容供应商大多不认 video_url 分片——因此 video_input 只有 native/none 两态；frames 抽帧模式（qwen-vl 类先抽帧再送图的间接路径）经确认不需要，已从范围内移除，使用 openai 兼容模型时请直接选 video_input: none。
3. 视频上传仅支持 data URL 内联（Gemini native 直传）；HTTP 外链视频需 Gemini File API，未实现。
4. 智控台（manager-api/manager-web）界面支持、聊天历史存档视频、ESP32 固件，仍按 §8 P2 另行排期。
