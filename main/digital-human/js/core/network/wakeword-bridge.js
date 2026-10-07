import { uiController } from '../../ui/controller.js?v=0206';
import { log } from '../../utils/logger.js?v=0206';

let wakewordSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let shouldReconnect = true;
let wakewordRequestSeq = 0;
let onNextBridgeConnectedCallback = null;

const pendingWakewordRequests = new Map();

export function startWakewordBridgeListener() {
    if (wakewordSocket) {
        return wakewordSocket;
    }

    shouldReconnect = true;
    log('姝ｅ湪杩炴帴鏈湴鍞ら啋浜嬩欢妗?..', 'info');
    tryConnect();
    return wakewordSocket;
}

function tryConnect() {
    const bridgeUrl = buildWakewordBridgeUrl();

    try {
        wakewordSocket = new WebSocket(bridgeUrl);
        wakewordSocket.onopen = () => {
            reconnectAttempts = 0;
            log(`鏈湴鍞ら啋浜嬩欢妗ュ凡杩炴帴: ${bridgeUrl}`, 'success');
            // 杩炴帴鎴愬姛鍚庤嚜鍔ㄤ繚瀛樺湴鍧€锛屽埛鏂板悗浠嶈兘璁颁綇
            localStorage.setItem('xz_tester_wakewordWsUrl', bridgeUrl);
            const urlInput = document.getElementById('wakewordWsUrl');
            if (urlInput) urlInput.value = bridgeUrl;
        };

        wakewordSocket.onerror = () => {
            log(`鏈湴鍞ら啋浜嬩欢妗ヨ繛鎺ュけ璐? ${bridgeUrl}`, 'error');
        };

        wakewordSocket.onmessage = async (event) => {
            try {
                const message = parseWakewordBridgeMessage(event.data);
                if (message.requestId && pendingWakewordRequests.has(message.requestId)) {
                    settleWakewordRequest(message);
                    return;
                }

                if (message.success === false) {
                    log(`鏈湴鍞ら啋浜嬩欢妗ヨ繑鍥為敊璇? ${message.error || '鏈煡閿欒'}`, 'error');
                    return;
                }

                if (message.type === 'bridge_connected') {
                    log('鏈湴鍞ら啋鐩戝惉宸插氨缁?, 'info');
                    if (onNextBridgeConnectedCallback) {
                        const cb = onNextBridgeConnectedCallback;
                        onNextBridgeConnectedCallback = null;
                        cb(message);
                    }
                    return;
                }

                if (message.type === 'service_ready') {
                    log('鏈湴鍞ら啋鏈嶅姟宸插惎鍔?, 'info');
                    return;
                }

                if (message.type === 'wakeword_config') {
                    uiController.applyWakewordConfig(message.payload || {});
                    log('宸插悓姝ユ湰鍦板敜閱掕瘝閰嶇疆', 'info');
                    return;
                }

                if (message.type === 'service_stopping') {
                    log('鏈湴鍞ら啋鏈嶅姟姝ｅ湪鍋滄', 'warning');
                    return;
                }

                if (message.type === 'wake_word_detected') {
                    const wakeWord = message.payload?.wake_word || '鍞ら啋璇?;
                    log(`妫€娴嬪埌鏈湴鍞ら啋浜嬩欢: ${wakeWord}`, 'info');
                    await uiController.triggerWakewordDial(wakeWord);
                }
            } catch (error) {
                log(`瑙ｆ瀽鏈湴鍞ら啋浜嬩欢澶辫触: ${error.message}`, 'error');
            }
        };

        wakewordSocket.onclose = () => {
            if (wakewordSocket) {
                wakewordSocket = null;
            }

            rejectAllWakewordRequests('鏈湴鍞ら啋浜嬩欢妗ュ凡鏂紑');

            if (!shouldReconnect) {
                return;
            }

            if (reconnectTimer) {
                return;
            }

            reconnectAttempts += 1;
            const delay = Math.min(1000 * reconnectAttempts, 5000);
            log(`鏈湴鍞ら啋浜嬩欢妗ュ皢鍦?${delay}ms 鍚庨噸杩? ${bridgeUrl}`, 'warning');
            reconnectTimer = window.setTimeout(() => {
                reconnectTimer = null;
                tryConnect();
            }, delay);
        };

        return wakewordSocket;
    } catch (error) {
        log(`鍚姩鏈湴鍞ら啋鐩戝惉澶辫触: ${error.message}`, 'error');
        return null;
    }
}

export function stopWakewordBridgeListener() {
    shouldReconnect = false;

    if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (!wakewordSocket) {
        return;
    }

    wakewordSocket.onclose = null;
    wakewordSocket.close();
    wakewordSocket = null;
}

export function sendWakewordBridgeMessage(type, payload = {}, requestId = null) {
    if (!wakewordSocket || wakewordSocket.readyState !== WebSocket.OPEN) {
        log('鏈湴鍞ら啋浜嬩欢妗ユ湭杩炴帴锛屾棤娉曞彂閫佹秷鎭?, 'warning');
        return false;
    }

    wakewordSocket.send(JSON.stringify({
        type,
        requestId,
        payload,
    }));
    return true;
}

export function requestWakewordBridge(type, payload = {}, timeout = 5000) {
    const requestId = `wakeword-${Date.now()}-${++wakewordRequestSeq}`;

    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
            pendingWakewordRequests.delete(requestId);
            reject(new Error('鏈湴鍞ら啋鏈嶅姟鍝嶅簲瓒呮椂'));
        }, timeout);

        pendingWakewordRequests.set(requestId, { resolve, reject, timer });

        if (!sendWakewordBridgeMessage(type, payload, requestId)) {
            window.clearTimeout(timer);
            pendingWakewordRequests.delete(requestId);
            reject(new Error('鏈湴鍞ら啋浜嬩欢妗ユ湭杩炴帴'));
        }
    });
}

export function getWakewordBridgeUrl() {
    if (wakewordSocket && wakewordSocket.url) {
        return wakewordSocket.url;
    }
    return buildWakewordBridgeUrl();
}

export function onNextBridgeConnected(callback) {
    onNextBridgeConnectedCallback = callback;
}

function buildWakewordBridgeUrl() {
    const configured = localStorage.getItem('xz_tester_wakewordWsUrl');
    if (configured && configured.trim()) {
        return configured.trim();
    }
    return 'ws://127.0.0.1:8006/wakeword-ws';
}

function parseWakewordBridgeMessage(rawData) {
    const message = JSON.parse(rawData);
    return {
        type: message.type || '',
        requestId: message.requestId || null,
        success: message.success !== false,
        payload: message.payload || {},
        error: message.error || null,
    };
}

function settleWakewordRequest(message) {
    const pendingRequest = pendingWakewordRequests.get(message.requestId);
    if (!pendingRequest) {
        return;
    }

    window.clearTimeout(pendingRequest.timer);
    pendingWakewordRequests.delete(message.requestId);

    if (message.success === false) {
        pendingRequest.reject(new Error(message.error || '鏈湴鍞ら啋鏈嶅姟杩斿洖澶辫触'));
        return;
    }

    pendingRequest.resolve(message);
}

function rejectAllWakewordRequests(errorMessage) {
    pendingWakewordRequests.forEach((pendingRequest) => {
        window.clearTimeout(pendingRequest.timer);
        pendingRequest.reject(new Error(errorMessage));
    });
    pendingWakewordRequests.clear();
}