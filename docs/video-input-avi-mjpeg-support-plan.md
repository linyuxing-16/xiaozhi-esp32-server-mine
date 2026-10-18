# video_input 支持 AVI/MJPEG 上传 —— 服务端改造计划

> 目标一句话：**让 video_input 视频上传接口在现有 webm/mp4 之外，接受 ESP32 固件端封装的 AVI(MJPG) 录像，并在服务端统一转码为 MP4 后直入大模型上下文**。
>
> 文档版本：v1.0（计划稿，未实施）｜配套文档：固件端计划见 `78/xiaozhi-esp32` 仓库

---

## 1. 背景与动机

- 现有 video_input（VAD 触发摄像头录像直入大模型上下文，M1~M5）只接受浏览器 MediaRecorder 产出的 webm/mp4。
- ESP32 固件端（立创实战派 szpi-esp32s3）要在 MCU 上录像，最现实的封装是 **AVI 容器 + MJPG 编码**（RIFF 结构简单、逐帧 JPEG 直塞，无需重编码）。
- 因此服务端上传接口 `POST /mcp/vision/video` 需要放宽格式白名单，并补一层转码，保证下游 LLM 拿到的仍是标准 mp4。

## 2. 现状梳理（关键代码位置）

| 环节 | 位置 | 现状 |
| --- | --- | --- |
| 魔数白名单 | `main/xiaozhi-server/core/api/video_handler.py` 顶部 `VIDEO_MAGIC_BYTES` | 仅 EBML（webm/mkv）与 `ftyp`（mp4/mov） |
| Content-Type 白名单 | 同文件 `ALLOWED_CONTENT_TYPES` | webm/mp4/x-matroska/quicktime/ogg/octet-stream，**无 avi** |
| 校验逻辑 | 同文件 `handle_post` 第 6 步 | `if not (type_ok and magic_ok) and not (type_ok or magic_ok)` —— 等价于 `not (type_ok or magic_ok)`，前半段冗余（顺手简化） |
| 落盘扩展名 | 同文件第 7 步 | `webm/matroska→.webm`，**其余一律 .mp4**（AVI 落进来会被错误命名） |
| 视频分片组装 | `core/handle/videoInputController.py` 315 行 `read_video_as_part` | 读文件 → base64 → `{"type":"video_url","video_url":{"url":"data:<mime>;base64,..."}}`，mime 来自上传时的 Content-Type |
| LLM 消费 | `core/providers/llm/gemini/gemini.py` | `video_url` 分片映射为 `inline_data`，**mime_type 硬编码 "video/webm"**（现存隐患：上传 mp4 也会被标成 webm） |
| 注入点 | `core/connection.py` 1100~1122 行 `chat()` | `take_pending_video → read_video_as_part → Message(content=[text, video_part])` |
| 配置 | `main/xiaozhi-server/config.yaml` 90 行起 `features.video_input` | enabled/trigger/cooldown/max_duration_ms 等 |

## 3. 方案设计

### S1 白名单与落盘扩展（先打通通路）

`video_handler.py`：

1. `VIDEO_MAGIC_BYTES` 增加 AVI 判定：
   - ```python
     VIDEO_MAGIC_AVI = (b"RIFF", b"AVI ")   # data[0:4]=="RIFF" 且 data[8:12]=="AVI "
     ```
   - `_is_valid_video` 增加对应分支；可选增强：在文件头 4KB 内搜索 `MJPG` fourcc，仅放行 MJPG 编码（拒绝 XVID 等其他编码，MCU 解不了也没必要）。
2. `ALLOWED_CONTENT_TYPES` 增加：`video/avi`、`video/x-msvideo`、`video/x-mjpeg`。
3. 落盘扩展名映射：命中 AVI 魔数或 avi 类 Content-Type → `.avi`；不再"其余一律 .mp4"。
4. 错误提示文案补充 avi。
5. 顺手把第 6 步冗余条件简化为 `if not (type_ok or magic_ok)`。

**不做**：裸 MJPEG 字节流（无容器、无帧率/时长信息，LLM 与转码都无法正确处理）——明确拒绝并提示"请封装为 AVI(MJPG)"。

### S2 转码层（保证下游统一吃 mp4）

- 位置：`handle_post` 落盘之后、`deliver_upload` 之前（HTTP 请求内完成，编排器与 chat() 零改动）。
- 工具：ffmpeg 子进程（参数列表执行，**禁止 shell 拼接**）：
  - ```
    ffmpeg -y -f avi -i <input.avi> -t <max_duration_ms/1000 + 1s> \
           -c:v libx264 -pix_fmt yuv420p -movflags +faststart <output.mp4>
    ```
- 安全与资源约束：
  - 输入沿用 `max_file_mb`（默认 25MB）限制；
  - 转码超时（默认 15s）超时杀进程并返回 500；
  - 输出文件大小上限（默认 `max_file_mb` 同值）；
  - 转码产物**再次做魔数校验**（必须 ftyp）后才 `deliver_upload`。
- 配置（`config.yaml` → `features.video_input` 新增节）：
  - ```yaml
    accept_avi: true            # 是否接受 AVI(MJPG) 上传
    transcode:
      enabled: true             # 开启后 AVI 一律转码为 mp4 再进上下文
      ffmpeg_path: "ffmpeg"
      timeout_sec: 15
    ```
- 降级策略：
  - `transcode.enabled=false` 或 ffmpeg 不可用：AVI 上传返回 415，错误信息注明"服务端未启用转码"；
  - **不**把原始 AVI 直接透传给 LLM（MJPG 编码在 Gemini 的 AVI 支持上属未验证路径，不做默认行为）。

### S3 MIME 传播修正（顺带修 bug）

- `gemini.py`：`video_url` 分片的 mime 不再硬编码 `video/webm`，改为从 data URI 前缀解析（`data:video/mp4;base64,...` → `video/mp4`），解析失败再回退 webm。
- 影响面：现有浏览器客户端上传 mp4 的场景 mime 标注随之修正（此前被错标 webm）。

## 4. 配置与文档同步

- `config.yaml` 注释补充 avi 说明；
- `docs/vad-camera-video-input-plan.md` 中"webm/mp4 或帧序列"的表述补一句"服务端额外支持 AVI(MJPG) 并自动转码（v1.1 起）"；
- 若智控台参数页有 video_input 相关注释，同步。

## 5. 测试计划

1. 单测（对齐既有 pytest 风格）：
   - `_is_valid_video`：合法 AVI(MJPG)、RIFF 非 AVI（如 WAV）、RIFF+AVI 但无 MJPG、截断文件；
   - 落盘扩展名：avi/webm/mp4 三分支；
   - 转码：enabled+ffmpeg 缺失 → 415；超时 → 500；产物复检失败 → 500。
2. 集成：`scripts/video_input_fake_client.py` 扩展 `--format avi` 选项，用 ffmpeg 预生成 3~5 秒 MJPG 样例上传，端到端确认 chat() 上下文里出现 `data:video/mp4` 分片。
3. 回归：既有 35 + 58 个用例全绿；浏览器 webm 路径不受影响。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| ffmpeg 是新部署依赖 | 可选依赖：缺失时功能降级并明确报错；Docker 镜像补充安装 |
| AVI 解析攻击面（畸形 RIFF） | 尺寸上限 + ffmpeg 超时 + 参数列表执行 + 转码后复检魔数 |
| MJPG 帧率异常导致转码时长膨胀 | `-t` 封顶；`dwMicroSecPerFrame` 异常（0 或离谱值）时按 8fps 兜底（固件侧保证写入正确帧率） |
| 转码耗时拉长上传回执 | 5s@VGA MJPG ≈ 2MB，转码 <1s，预期无感；超时兜底已有 |

## 7. 实施顺序

1. **S1** 白名单 + 扩展名 + 冗余条件简化（半小时级，配合固件 F2 阶段即可联调）
2. **S3** gemini mime 解析修正（小，独立提交）
3. **S2** 转码层 + 配置 + Docker 依赖（主体工作量）
4. 文档同步 + 集成脚本扩展

---

## 8. 实施记录（已完成）

### 8.1 代码落地

| 阶段 | 文件 | 内容 |
| --- | --- | --- |
| S1 | `core/api/video_handler.py` | `VIDEO_MAGIC_AVI`（RIFF+AVI 魔数）、`_avi_has_mjpg`（头部4KB内 MJPG fourcc 校验，拒绝 XVID 等其他编码）、`ALLOWED_CONTENT_TYPES` 增加 `video/avi`/`video/x-msvideo`/`video/x-mjpeg`、`_pick_ext` 扩展名映射（avi/webm/mp4，魔数优先）、第6步冗余条件简化为 `not (type_ok or magic_ok)` |
| S1门禁 | 同上 | 裸 MJPEG 字节流明确拒绝（提示"请封装为 AVI(MJPG)"）；`accept_avi=false` 时 AVI 整体按不支持格式拒绝（415） |
| S2 | 同上 | `_transcode_avi_to_mp4`：ffmpeg 参数列表执行（`-f avi` 强制解封装、`-t` 封顶 max_duration+1s、libx264/yuv420p/faststart）、默认线程池执行不阻塞事件循环、超时杀进程、输出大小上限（`max_file_mb` 同值）、产物 ftyp 魔数复检；降级：`transcode.enabled=false` 或 ffmpeg 缺失 → 415；转码运行时失败（超时/复检失败等）→ 500；原始 AVI 一律不透传 |
| S2配置 | `config.yaml` | `features.video_input` 新增 `accept_avi` 与 `transcode`（enabled/ffmpeg_path/timeout_sec）节 |
| S3 | `core/providers/llm/gemini/gemini.py` | 见 8.2 说明：mime 从 data URI 前缀解析并统一小写归一；视频解析失败回退 `video/webm`，图片回退 `image/jpeg` |
| 集成脚本 | `scripts/video_input_fake_client.py` | 新增 `--format avi`（ffmpeg 预生成 3~5 秒 MJPG 样例，`--sample-sec` 可调）参数 |
| 文档 | `docs/vad-camera-video-input-plan.md` | 媒体类型对比与上传协议处补 AVI(MJPG) 说明 |

### 8.2 与计划的两处出入（核实结论）

1. **S3 所述"mime_type 硬编码 video/webm"在当前代码已不存在**：`gemini.py` 的 `_build_part` 在 M1~M5 提交中已实现从 data URI 前缀解析 mime。本次落地改为：解析结果统一 `strip().lower()` 归一（防上游大小写差异），并把图片分片的兜底默认值从 `video/webm` 修正为 `image/jpeg`（此前图片/视频共用一个默认值），另补 8 个单测固化该行为。
2. **Docker 依赖无需新增**：`Dockerfile-server-base` 已安装 ffmpeg（`apt-get install ... ffmpeg ...`），无需改动。

### 8.3 测试落地（视频相关 33 例全绿）

- `tests/core/api/test_video_handler_avi.py`（19 例）：`_is_valid_video`（合法 AVI(MJPG)/RIFF 非 AVI(WAV)/RIFF+AVI 无 MJPG/截断文件）、`_pick_ext` 三分支、`_derive_mime`、MJPG 门禁 415、`accept_avi=false` 415、转码降级 415（未启用/ffmpeg 缺失）、转码超时 500、产物复检失败 500、**真实 ffmpeg 端到端**（AVI(MJPG)→MP4→投递 mime=video/mp4→`data:video/mp4` 分片）；
- `tests/core/providers/llm/test_gemini_video_mime.py`（8 例）：mp4/webm 映射、缺失 mime 回退、大小写归一、图片回退、http 链接跳过；
- 既有 `test_video_handler_http.py`（6 例）与 `test_video_input_controller.py`（18 例）回归通过。

> 本机运行提示：若 Windows 下 pytest 临时目录（`%TEMP%\pytest-of-*`）ACL 异常导致 `tmp_path` 报拒绝访问，可加 `--basetemp=tmp/pytest-basetemp` 重定向到工作区内运行。
