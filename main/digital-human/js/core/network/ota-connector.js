import { log } from '../../utils/logger.js?v=0206';

// WebSocket 杩炴帴
export async function webSocketConnect(otaUrl, config) {

    if (!validateConfig(config)) {
        return;
    }

    // 鍙戦€丱TA璇锋眰骞惰幏鍙栬繑鍥炵殑websocket淇℃伅
    const otaResult = await sendOTA(otaUrl, config);
    if (!otaResult) {
        log('鏃犳硶浠嶰TA鏈嶅姟鍣ㄨ幏鍙栦俊鎭?, 'error');
        return;
    }

    // 浠嶰TA鍝嶅簲涓彁鍙杦ebsocket淇℃伅
    const { websocket } = otaResult;
    if (!websocket || !websocket.url) {
        log('OTA鍝嶅簲涓己灏憌ebsocket淇℃伅', 'error');
        return;
    }

    // 浣跨敤OTA杩斿洖鐨剋ebsocket URL
    let connUrl = new URL(websocket.url);

    // 娣诲姞token鍙傛暟锛堜粠OTA鍝嶅簲涓幏鍙栵級
    if (websocket.token) {
        if (websocket.token.startsWith("Bearer ")) {
            connUrl.searchParams.append('authorization', websocket.token);
        } else {
            connUrl.searchParams.append('authorization', 'Bearer ' + websocket.token);
        }
    }

    // 娣诲姞璁よ瘉鍙傛暟锛堜繚鎸佸師鏈夐€昏緫锛?
    connUrl.searchParams.append('device-id', config.deviceId);
    connUrl.searchParams.append('client-id', config.clientId);

    const wsurl = connUrl.toString()

    log(`姝ｅ湪杩炴帴: ${wsurl}`, 'info');

    if (wsurl) {
        document.getElementById('serverUrl').value = wsurl;
    }

    return new WebSocket(connUrl.toString());
}

// 楠岃瘉閰嶇疆
function validateConfig(config) {
    if (!config.deviceMac) {
        log('璁惧MAC鍦板潃涓嶈兘涓虹┖', 'error');
        return false;
    }
    if (!config.clientId) {
        log('瀹㈡埛绔疘D涓嶈兘涓虹┖', 'error');
        return false;
    }
    return true;
}

// OTA鍙戦€佽姹傦紝楠岃瘉鐘舵€侊紝骞惰繑鍥炲搷搴旀暟鎹?
async function sendOTA(otaUrl, config) {
    try {
        const res = await fetch(otaUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Device-Id': config.deviceId,
                'Client-Id': config.clientId
            },
            body: JSON.stringify({
                version: 0,
                uuid: '',
                application: {
                    name: 'xiaozhi-web-test',
                    version: '1.0.0',
                    compile_time: '2025-04-16 10:00:00',
                    idf_version: '4.4.3',
                    elf_sha256: '1234567890abcdef1234567890abcdef1234567890abcdef'
                },
                ota: { label: 'xiaozhi-web-test' },
                board: {
                    type: config.deviceName,
                    ssid: 'xiaozhi-web-test',
                    rssi: 0,
                    channel: 0,
                    ip: '192.168.1.1',
                    mac: config.deviceMac
                },
                flash_size: 0,
                minimum_free_heap_size: 0,
                mac_address: config.deviceMac,
                chip_model_name: '',
                chip_info: { model: 0, cores: 0, revision: 0, features: 0 },
                partition_table: [{ label: '', type: 0, subtype: 0, address: 0, size: 0 }]
            })
        });

        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

        const result = await res.json();
        return result; // 杩斿洖瀹屾暣鐨勫搷搴旀暟鎹?
    } catch (err) {
        return null; // 澶辫触杩斿洖null
    }
}