// WebSocket娑堟伅澶勭悊妯″潡
import { getConfig, saveConnectionUrls } from '../../config/manager.js?v=0206';
import { uiController } from '../../ui/controller.js?v=0206';
import { log } from '../../utils/logger.js?v=0206';
import { getAudioPlayer } from '../audio/player.js?v=0206';
import { getAudioRecorder } from '../audio/recorder.js?v=0206';
import { executeMcpTool, getMcpTools, setWebSocket as setMcpWebSocket } from '../mcp/tools.js?v=0206';
import { webSocketConnect } from './ota-connector.js?v=0206';

// WebSocket澶勭悊鍣ㄧ被
export class WebSocketHandler {
    constructor() {
        this.websocket = null;
        this.onConnectionStateChange = null;
        this.onRecordButtonStateChange = null;
        this.onSessionStateChange = null;
        this.onSessionEmotionChange = null;
        this.onChatMessage = null; // 鏂板锛氳亰澶╂秷鎭洖璋?
        this.currentSessionId = null;
        this.isRemoteSpeaking = false;
    }

    // 鍙戦€乭ello鎻℃墜娑堟伅
    async sendHelloMessage() {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return false;

        try {
            const config = getConfig();

            const helloMessage = {
                type: 'hello',
                device_id: config.deviceId,
                device_name: config.deviceName,
                device_mac: config.deviceMac,
                token: config.token,
                features: {
                    mcp: true,
                    emoji: config.emojiEnabled
                }
            };

            log('鍙戦€乭ello鎻℃墜娑堟伅', 'info');
            this.websocket.send(JSON.stringify(helloMessage));

            return new Promise(resolve => {
                const timeout = setTimeout(() => {
                    log('绛夊緟hello鍝嶅簲瓒呮椂', 'error');
                    log('鎻愮ず: 璇峰皾璇曠偣鍑?娴嬭瘯璁よ瘉"鎸夐挳杩涜杩炴帴鎺掓煡', 'info');
                    resolve(false);
                }, 5000);

                const onMessageHandler = (event) => {
                    try {
                        const response = JSON.parse(event.data);
                        if (response.type === 'hello' && response.session_id) {
                            log(`鏈嶅姟鍣ㄦ彙鎵嬫垚鍔燂紝浼氳瘽ID: ${response.session_id}`, 'success');
                            clearTimeout(timeout);
                            this.websocket.removeEventListener('message', onMessageHandler);
                            resolve(true);
                        }
                    } catch (e) {
                        // 蹇界暐闈濲SON娑堟伅
                    }
                };

                this.websocket.addEventListener('message', onMessageHandler);
            });
        } catch (error) {
            log(`鍙戦€乭ello娑堟伅閿欒: ${error.message}`, 'error');
            return false;
        }
    }

    _sendWakeupMessages(sessionId) {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;

        // listen detect
        this.websocket.send(JSON.stringify({
            session_id: sessionId,
            type: 'listen',
            state: 'detect',
            text: '鍢匡紝浣犲ソ鍛€'
        }));
        log('鍙戦€乴isten detect娑堟伅锛屽敜閱掕瘝: 鍢匡紝浣犲ソ鍛€', 'info');

        // listen start锛氬紑濮嬬洃鍚?
        this.websocket.send(JSON.stringify({
            session_id: sessionId,
            type: 'listen',
            state: 'start',
            mode: 'auto'
        }));
        log('鍙戦€乴isten start娑堟伅', 'info');
    }

    // 澶勭悊鏂囨湰娑堟伅
    handleTextMessage(message) {
        if (message.type === 'hello') {
            log(`鏈嶅姟鍣ㄥ洖搴旓細${JSON.stringify(message, null, 2)}`, 'success');
            window.cameraAvailable = true;
            log('杩炴帴鎴愬姛锛屾憚鍍忓ご宸插彲鐢?, 'success');
            uiController.updateDialButton(true);

            this._sendWakeupMessages(message.session_id);

            uiController.startAIChatSession();
        } else if (message.type === 'tts') {
            this.handleTTSMessage(message);
        } else if (message.type === 'audio') {
            log(`鏀跺埌闊抽鎺у埗娑堟伅: ${JSON.stringify(message)}`, 'info');
        } else if (message.type === 'stt') {
            log(`璇嗗埆缁撴灉: ${message.text}`, 'info');
            // 妫€鏌ユ槸鍚﹂渶瑕佺粦瀹氳澶?
            if (message.text && (message.text.includes('缁戝畾') || message.text.includes('bind'))) {
                log('鏀跺埌璁惧缁戝畾鎻愮ず锛屾洿鏂版憚鍍忓ご鐘舵€?, 'warning');
                window.cameraAvailable = false;
                // 鍏抽棴鎽勫儚澶?
                if (typeof window.stopCamera === 'function') {
                    window.stopCamera();
                }
                // 鏇存柊鎽勫儚澶存寜閽姸鎬?
                const cameraBtn = document.getElementById('cameraBtn');
                if (cameraBtn) {
                    cameraBtn.classList.remove('camera-active');
                    cameraBtn.querySelector('.btn-text').textContent = '鎽勫儚澶?;
                    cameraBtn.disabled = true;
                    cameraBtn.title = '璇峰厛缁戝畾楠岃瘉鐮?;
                }
            }
            // 浣跨敤鏂扮殑鑱婂ぉ娑堟伅鍥炶皟鏄剧ずSTT娑堟伅
            if (this.onChatMessage && message.text) {
                this.onChatMessage(message.text, true);
            }
        } else if (message.type === 'llm') {
            log(`澶фā鍨嬪洖澶? ${message.text}`, 'info');
            // 浣跨敤鏂扮殑鑱婂ぉ娑堟伅鍥炶皟鏄剧ずLLM鍥炲
            if (this.onChatMessage && message.text) {
                this.onChatMessage(message.text, false);
            }

            // 濡傛灉鍖呭惈琛ㄦ儏锛屾洿鏂皊essionStatus琛ㄦ儏骞惰Е鍙慙ive2D鍔ㄤ綔
            if (message.text && /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u.test(message.text)) {
                // 鎻愬彇琛ㄦ儏绗﹀彿
                const emojiMatch = message.text.match(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u);
                if (emojiMatch && this.onSessionEmotionChange) {
                    this.onSessionEmotionChange(emojiMatch[0]);
                }

                // 瑙﹀彂Live2D鎯呯华鍔ㄤ綔
                if (message.emotion) {
                    console.log(`鏀跺埌鎯呯华娑堟伅: emotion=${message.emotion}, text=${message.text}`);
                    this.triggerLive2DEmotionAction(message.emotion);
                }
            }

            // 鍙湁褰撴枃鏈笉浠呬粎鏄〃鎯呮椂锛屾墠娣诲姞鍒板璇濅腑
            // 绉婚櫎鏂囨湰涓殑琛ㄦ儏鍚庢鏌ユ槸鍚﹁繕鏈夊唴瀹?
            const textWithoutEmoji = message.text ? message.text.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim() : '';
            if (textWithoutEmoji && this.onChatMessage) {
                this.onChatMessage(message.text, false);
            }
        } else if (message.type === 'mcp') {
            this.handleMCPMessage(message);
        } else if (message.type === 'camera') {
            this.handleCameraMessage(message);
        } else {
            log(`鏈煡娑堟伅绫诲瀷: ${message.type}`, 'info');
            if (this.onChatMessage) {
                this.onChatMessage(`鏈煡娑堟伅绫诲瀷: ${message.type}\n${JSON.stringify(message, null, 2)}`, false);
            }
        }
    }

    // 澶勭悊TTS娑堟伅
    handleTTSMessage(message) {
        if (message.state === 'start') {
            log('鏈嶅姟鍣ㄥ紑濮嬪彂閫佽闊?, 'info');
            this.currentSessionId = message.session_id;
            this.isRemoteSpeaking = true;
            if (this.onSessionStateChange) {
                this.onSessionStateChange(true);
            }

            // 鍚姩Live2D璇磋瘽鍔ㄧ敾
            this.startLive2DTalking();
        } else if (message.state === 'sentence_start') {
            log(`鏈嶅姟鍣ㄥ彂閫佽闊虫: ${message.text}`, 'info');
            this.ttsSentenceCount = (this.ttsSentenceCount || 0) + 1;

            if (message.text && this.onChatMessage) {
                this.onChatMessage(message.text, false);
            }

            // 纭繚鍔ㄧ敾鍦ㄥ彞瀛愬紑濮嬫椂杩愯
            const live2dManager = window.chatApp?.live2dManager;
            if (live2dManager && !live2dManager.isTalking) {
                this.startLive2DTalking();
            }
        } else if (message.state === 'sentence_end') {
            log(`璇煶娈电粨鏉? ${message.text}`, 'info');

            // 鍙ュ瓙缁撴潫鏃朵笉娓呴櫎鍔ㄧ敾锛岀瓑寰呬笅涓€涓彞瀛愭垨鏈€缁堝仠姝?
        } else if (message.state === 'stop') {
            log('鏈嶅姟鍣ㄨ闊充紶杈撶粨鏉燂紝娓呯┖鎵€鏈夐煶棰戠紦鍐?, 'info');

            // 娓呯┖鎵€鏈夐煶棰戠紦鍐插苟鍋滄鎾斁
            const audioPlayer = getAudioPlayer();
            audioPlayer.clearAllAudio();

            this.isRemoteSpeaking = false;
            if (this.onRecordButtonStateChange) {
                this.onRecordButtonStateChange(false);
            }
            if (this.onSessionStateChange) {
                this.onSessionStateChange(false);
            }

            // 寤惰繜鍋滄Live2D璇磋瘽鍔ㄧ敾锛岀‘淇濇墍鏈夊彞瀛愰兘鎾斁瀹屾瘯
            setTimeout(() => {
                this.stopLive2DTalking();
                this.ttsSentenceCount = 0; // 閲嶇疆璁℃暟鍣?
            }, 1000); // 1绉掑欢杩燂紝纭繚鎵€鏈夊彞瀛愰兘瀹屾垚
        }
    }

    // 鍚姩Live2D璇磋瘽鍔ㄧ敾
    startLive2DTalking() {
        try {
            // 鑾峰彇Live2D绠＄悊鍣ㄥ疄渚?
            const live2dManager = window.chatApp?.live2dManager;
            if (live2dManager && live2dManager.live2dModel) {
                // 浣跨敤闊抽鎾斁鍣ㄧ殑鍒嗘瀽鍣ㄨ妭鐐?
                live2dManager.startTalking();
                log('Live2D璇磋瘽鍔ㄧ敾宸插惎鍔?, 'info');
            }
        } catch (error) {
            log(`鍚姩Live2D璇磋瘽鍔ㄧ敾澶辫触: ${error.message}`, 'error');
        }
    }

    // 鍋滄Live2D璇磋瘽鍔ㄧ敾
    stopLive2DTalking() {
        try {
            const live2dManager = window.chatApp?.live2dManager;
            if (live2dManager) {
                live2dManager.stopTalking();
                log('Live2D璇磋瘽鍔ㄧ敾宸插仠姝?, 'info');
            }
        } catch (error) {
            log(`鍋滄Live2D璇磋瘽鍔ㄧ敾澶辫触: ${error.message}`, 'error');
        }
    }

    // 鍒濆鍖朙ive2D闊抽鍒嗘瀽鍣?
    initializeLive2DAudioAnalyzer() {
        try {
            const live2dManager = window.chatApp?.live2dManager;
            if (live2dManager) {
                // 鍒濆鍖栭煶棰戝垎鏋愬櫒锛堜娇鐢ㄩ煶棰戞挱鏀惧櫒鐨勪笂涓嬫枃锛?
                if (live2dManager.initializeAudioAnalyzer()) {
                    log('Live2D闊抽鍒嗘瀽鍣ㄥ垵濮嬪寲瀹屾垚锛屽凡杩炴帴鍒伴煶棰戞挱鏀惧櫒', 'success');
                } else {
                    log('Live2D闊抽鍒嗘瀽鍣ㄥ垵濮嬪寲澶辫触锛屽皢浣跨敤妯℃嫙鍔ㄧ敾', 'warning');
                }
            }
        } catch (error) {
            log(`鍒濆鍖朙ive2D闊抽鍒嗘瀽鍣ㄥけ璐? ${error.message}`, 'error');
        }
    }

    // 澶勭悊鏈嶅姟绔笅鍙戠殑鎽勫儚澶村綍鍍忓懡浠わ紙VAD瑙﹀彂褰曞儚鐩村叆涓婁笅鏂囷級
    handleCameraMessage(message) {
        const command = message.command;
        const requestId = message.request_id;

        if (command === 'start_record') {
            log('鏈嶅姟绔姹傚綍鍍? request_id=' + requestId + ', 鏈€闀? + (message.max_duration_ms || 5000) + 'ms', 'info');
            // 褰曞儚瀹屾垚鍚庤嚜鍔ㄤ笂浼狅紙褰曞儚涓庝笂浼犱覆鑱旓紝鏈嶅姟绔痗hat渚х瓑寰呰瑙嗛锛?
            if (typeof window.recordVideo === 'function') {
                window.recordVideo({
                    requestId: requestId,
                    maxDurationMs: message.max_duration_ms || 5000
                }).then(blob => {
                    if (blob && typeof window.uploadVideoBlob === 'function') {
                        window.uploadVideoBlob(blob, requestId);
                    }
                }).catch(error => {
                    log('褰曞儚娴佺▼澶辫触: ' + error.message, 'error');
                });
            } else {
                log('瀹㈡埛绔湭瀹炵幇褰曞儚鍔熻兘锛屽拷鐣?, 'warning');
            }
        } else if (command === 'stop_record') {
            // 鎻愬墠鍋滄锛氬綍鍍廝romise闅忓嵆resolve骞惰Е鍙戜笂浼?
            if (typeof window.stopVideoRecording === 'function') {
                window.stopVideoRecording();
            }
        } else {
            log('鏈煡鐨刢amera鍛戒护: ' + command, 'warning');
        }
    }

    // 鍙戦€佸綍鍍忓紑濮嬪洖鎵э紙1绉掑唴涓嶅洖鎵ф湇鍔＄瑙嗕负瀹㈡埛绔笉鏀寔锛?
    sendRecordingStartedAck(requestId) {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
        this.websocket.send(JSON.stringify({
            type: 'camera',
            command: 'record_started',
            request_id: requestId
        }));
        log('宸插洖鎵ecord_started: ' + requestId, 'info');
    }

    // 澶勭悊MCP娑堟伅
    handleMCPMessage(message) {
        const payload = message.payload || {};
        log(`鏈嶅姟鍣ㄤ笅鍙? ${JSON.stringify(message)}`, 'info');

        if (payload.method === 'tools/list') {
            const tools = getMcpTools();

            const replyMessage = JSON.stringify({
                "session_id": message.session_id || "",
                "type": "mcp",
                "payload": {
                    "jsonrpc": "2.0",
                    "id": payload.id,
                    "result": {
                        "tools": tools
                    }
                }
            });
            log(`瀹㈡埛绔笂鎶? ${replyMessage}`, 'info');
            this.websocket.send(replyMessage);
            log(`鍥炲MCP宸ュ叿鍒楄〃: ${tools.length} 涓伐鍏穈, 'info');

        } else if (payload.method === 'tools/call') {
            const toolName = payload.params?.name;
            const toolArgs = payload.params?.arguments;

            log(`璋冪敤宸ュ叿: ${toolName} 鍙傛暟: ${JSON.stringify(toolArgs)}`, 'info');

            executeMcpTool(toolName, toolArgs).then(result => {
                const replyMessage = JSON.stringify({
                    "session_id": message.session_id || "",
                    "type": "mcp",
                    "payload": {
                        "jsonrpc": "2.0",
                        "id": payload.id,
                        "result": {
                            "content": [
                                {
                                    "type": "text",
                                    "text": JSON.stringify(result)
                                }
                            ],
                            "isError": false
                        }
                    }
                });

                log(`瀹㈡埛绔笂鎶? ${replyMessage}`, 'info');
                this.websocket.send(replyMessage);
            }).catch(error => {
                log(`宸ュ叿鎵ц澶辫触: ${error.message}`, 'error');
                const errorReply = JSON.stringify({
                    "session_id": message.session_id || "",
                    "type": "mcp",
                    "payload": {
                        "jsonrpc": "2.0",
                        "id": payload.id,
                        "error": {
                            "code": -32603,
                            "message": error.message
                        }
                    }
                });
                this.websocket.send(errorReply);
            });
        } else if (payload.method === 'initialize') {
            log(`鏀跺埌宸ュ叿鍒濆鍖栬姹? ${JSON.stringify(payload.params)}`, 'info');
            // 淇濆瓨瑙嗚鍒嗘瀽鎺ュ彛鍦板潃
            const visionUrl = document.getElementById('visionUrl');
            const visionConfig = payload?.params?.capabilities?.vision;
            if (visionConfig && typeof visionConfig === 'object' && visionConfig.url && visionConfig.token) {
                const visionConfigStr = JSON.stringify(visionConfig);
                localStorage.setItem('xz_tester_vision', visionConfigStr);
                if (visionUrl) visionUrl.value = visionConfig.url;
            } else {
                localStorage.removeItem('xz_tester_vision');
                if (visionUrl) visionUrl.value = '';
            }

            const replyMessage = JSON.stringify({
                "session_id": message.session_id || "",
                "type": "mcp",
                "payload": {
                    "jsonrpc": "2.0",
                    "id": payload.id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {}
                        },
                        "serverInfo": {
                            "name": "xiaozhi-web-test",
                            "version": "2.1.0"
                        }
                    }
                }
            });
            log(`鍥炲鍒濆鍖栧搷搴擿, 'info');
            this.websocket.send(replyMessage);
        } else {
            log(`鏈煡鐨凪CP鏂规硶: ${payload.method}`, 'warning');
        }
    }

    // 澶勭悊浜岃繘鍒舵秷鎭?
    async handleBinaryMessage(data) {
        try {
            let arrayBuffer;
            if (data instanceof ArrayBuffer) {
                arrayBuffer = data;
            } else if (data instanceof Blob) {
                arrayBuffer = await data.arrayBuffer();
                log(`鏀跺埌Blob闊抽鏁版嵁锛屽ぇ灏? ${arrayBuffer.byteLength}瀛楄妭`, 'debug');
            } else {
                log(`鏀跺埌鏈煡绫诲瀷鐨勪簩杩涘埗鏁版嵁: ${typeof data}`, 'warning');
                return;
            }

            const opusData = new Uint8Array(arrayBuffer);
            const audioPlayer = getAudioPlayer();
            audioPlayer.enqueueAudioData(opusData);
        } catch (error) {
            log(`澶勭悊浜岃繘鍒舵秷鎭嚭閿? ${error.message}`, 'error');
        }
    }

    // 杩炴帴WebSocket鏈嶅姟鍣?
    async connect() {
        const config = getConfig();
        log('姝ｅ湪妫€鏌TA鐘舵€?..', 'info');
        saveConnectionUrls();

        try {
            const otaUrl = document.getElementById('otaUrl').value.trim();
            const ws = await webSocketConnect(otaUrl, config);
            if (ws === undefined) {
                return false;
            }
            this.websocket = ws;

            // 璁剧疆鎺ユ敹浜岃繘鍒舵暟鎹殑绫诲瀷涓篈rrayBuffer
            this.websocket.binaryType = 'arraybuffer';

            // 璁剧疆 MCP 妯″潡鐨?WebSocket 瀹炰緥
            setMcpWebSocket(this.websocket);

            // 璁剧疆褰曢煶鍣ㄧ殑WebSocket
            const audioRecorder = getAudioRecorder();
            audioRecorder.setWebSocket(this.websocket);

            this.setupEventHandlers();

            // 娉ㄥ唽褰曞儚寮€濮嬪洖鎵х洃鍚紙recordVideo鎴愬姛鍚姩鍚庤Е鍙戯級
            this._recordingStartedListener = (event) => {
                this.sendRecordingStartedAck(event.detail?.requestId);
            };
            window.addEventListener('video-recording-started', this._recordingStartedListener);

            return true;
        } catch (error) {
            log(`杩炴帴閿欒: ${error.message}`, 'error');
            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(false);
            }
            return false;
        }
    }

    // 璁剧疆浜嬩欢澶勭悊鍣?
    setupEventHandlers() {
        this.websocket.onopen = async () => {
            const url = document.getElementById('serverUrl').value;
            log(`宸茶繛鎺ュ埌鏈嶅姟鍣? ${url}`, 'success');

            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(true);
            }

            // 杩炴帴鎴愬姛鍚庯紝榛樿鐘舵€佷负鑱嗗惉涓?
            this.isRemoteSpeaking = false;
            if (this.onSessionStateChange) {
                this.onSessionStateChange(false);
            }

            // 鍦╓ebSocket杩炴帴鎴愬姛鏃跺垵濮嬪寲Live2D闊抽鍒嗘瀽鍣?
            this.initializeLive2DAudioAnalyzer();

            await this.sendHelloMessage();
        };

        this.websocket.onclose = () => {
            log('宸叉柇寮€杩炴帴', 'info');

            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(false);
            }

            // 娓呯悊褰曞儚鍥炴墽鐩戝惉涓庤繘琛屼腑鐨勫綍鍍忎細璇?
            if (this._recordingStartedListener) {
                window.removeEventListener('video-recording-started', this._recordingStartedListener);
                this._recordingStartedListener = null;
            }
            if (typeof window.stopVideoRecording === 'function') {
                window.stopVideoRecording();
            }
            // 鏂嚎鏃跺交搴曚腑姝㈡湭瀹屾垚浼氳瘽
            if (window.chatApp && typeof window.chatApp._abortVideoRecording === 'function') {
                window.chatApp._abortVideoRecording();
            }

            const audioRecorder = getAudioRecorder();
            audioRecorder.stop();

            // 鍏抽棴鎽勫儚澶?
            if (typeof window.stopCamera === 'function') {
                window.stopCamera();
            }

            // 闅愯棌鎽勫儚澶存樉绀哄尯鍩?
            const cameraContainer = document.getElementById('cameraContainer');
            if (cameraContainer) {
                cameraContainer.classList.remove('active');
            }
        };

        this.websocket.onerror = (error) => {
            log(`WebSocket閿欒: ${error.message || '鏈煡閿欒'}`, 'error');
            uiController.addChatMessage(`鈿狅笍 WebSocket閿欒: ${error.message || '鏈煡閿欒'}`, false);
            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(false);
            }
        };

        this.websocket.onmessage = (event) => {
            try {
                if (typeof event.data === 'string') {
                    const message = JSON.parse(event.data);
                    this.handleTextMessage(message);
                } else {
                    this.handleBinaryMessage(event.data);
                }
            } catch (error) {
                log(`WebSocket娑堟伅澶勭悊閿欒: ${error.message}`, 'error');
                // 涓嶅啀浣跨敤鏃х殑addMessage鍑芥暟锛屽洜涓篶onversationDiv鍏冪礌涓嶅瓨鍦?
                // 閿欒娑堟伅灏嗛€氳繃鍏朵粬鏂瑰紡鏄剧ず
            }
        };
    }

    // 鏂紑杩炴帴
    disconnect() {
        if (!this.websocket) return;

        this.websocket.close();
        const audioRecorder = getAudioRecorder();
        audioRecorder.stop();

        // 鍏抽棴鎽勫儚澶?
        if (typeof window.stopCamera === 'function') {
            window.stopCamera();
        }

        // 闅愯棌鎽勫儚澶存樉绀哄尯鍩?
        const cameraContainer = document.getElementById('cameraContainer');
        if (cameraContainer) {
            cameraContainer.classList.remove('active');
        }
    }

    // 鍙戦€佹枃鏈秷鎭?
    sendTextMessage(text) {
        if (text === '' || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            return false;
        }

        try {
            // 濡傛灉瀵规柟姝ｅ湪璇磋瘽锛屽厛鍙戦€佹墦鏂秷鎭?
            if (this.isRemoteSpeaking && this.currentSessionId) {
                const abortMessage = {
                    session_id: this.currentSessionId,
                    type: 'abort',
                    reason: 'wake_word_detected'
                };
                this.websocket.send(JSON.stringify(abortMessage));
                log('鍙戦€佹墦鏂秷鎭?, 'info');
            }

            const listenMessage = {
                type: 'listen',
                state: 'detect',
                text: text
            };

            this.websocket.send(JSON.stringify(listenMessage));
            log(`鍙戦€佹枃鏈秷鎭? ${text}`, 'info');

            return true;
        } catch (error) {
            log(`鍙戦€佹秷鎭敊璇? ${error.message}`, 'error');
            return false;
        }
    }

    /**
     * 瑙﹀彂Live2D鎯呯华鍔ㄤ綔
     * @param {string} emotion - 鎯呯华鍚嶇О
     */
    triggerLive2DEmotionAction(emotion) {
        try {
            const live2dManager = window.chatApp?.live2dManager;
            if (live2dManager && typeof live2dManager.triggerEmotionAction === 'function') {
                live2dManager.triggerEmotionAction(emotion);
                log(`瑙﹀彂Live2D鎯呯华鍔ㄤ綔: ${emotion}`, 'info');
            } else {
                log(`鏃犳硶瑙﹀彂Live2D鎯呯华鍔ㄤ綔: Live2D绠＄悊鍣ㄦ湭鎵惧埌鎴栨柟娉曚笉鍙敤`, 'warning');
            }
        } catch (error) {
            log(`瑙﹀彂Live2D鎯呯华鍔ㄤ綔澶辫触: ${error.message}`, 'error');
        }
    }

    // 鑾峰彇WebSocket瀹炰緥
    getWebSocket() {
        return this.websocket;
    }

    // 妫€鏌ユ槸鍚﹀凡杩炴帴
    isConnected() {
        return this.websocket && this.websocket.readyState === WebSocket.OPEN;
    }
}

// 鍒涘缓鍗曚緥
let wsHandlerInstance = null;

export function getWebSocketHandler() {
    if (!wsHandlerInstance) {
        wsHandlerInstance = new WebSocketHandler();
    }
    return wsHandlerInstance;
}
