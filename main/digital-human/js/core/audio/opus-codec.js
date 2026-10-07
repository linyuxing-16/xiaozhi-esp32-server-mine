import { log } from '../../utils/logger.js?v=0206';


// 妫€鏌pus搴撴槸鍚﹀凡鍔犺浇
export function checkOpusLoaded() {
    try {
        // 妫€鏌odule鏄惁瀛樺湪锛堟湰鍦板簱瀵煎嚭鐨勫叏灞€鍙橀噺锛?
        if (typeof Module === 'undefined') {
            throw new Error('Opus搴撴湭鍔犺浇锛孧odule瀵硅薄涓嶅瓨鍦?);
        }

        // 灏濊瘯鍏堜娇鐢∕odule.instance锛坙ibopus.js鏈€鍚庝竴琛屽鍑烘柟寮忥級
        if (typeof Module.instance !== 'undefined' && typeof Module.instance._opus_decoder_get_size === 'function') {
            // 浣跨敤Module.instance瀵硅薄鏇挎崲鍏ㄥ眬Module瀵硅薄
            window.ModuleInstance = Module.instance;
            log('Opus搴撳姞杞芥垚鍔燂紙浣跨敤Module.instance锛?, 'success');

            // 3绉掑悗闅愯棌鐘舵€?
            const statusElement = document.getElementById('scriptStatus');
            if (statusElement) statusElement.style.display = 'none';
            return;
        }

        // 濡傛灉娌℃湁Module.instance锛屾鏌ュ叏灞€Module鍑芥暟
        if (typeof Module._opus_decoder_get_size === 'function') {
            window.ModuleInstance = Module;
            log('Opus搴撳姞杞芥垚鍔燂紙浣跨敤鍏ㄥ眬Module锛?, 'success');

            // 3绉掑悗闅愯棌鐘舵€?
            const statusElement = document.getElementById('scriptStatus');
            if (statusElement) statusElement.style.display = 'none';
            return;
        }

        throw new Error('Opus瑙ｇ爜鍑芥暟鏈壘鍒帮紝鍙兘Module缁撴瀯涓嶆纭?);
    } catch (err) {
        log(`Opus搴撳姞杞藉け璐ワ紝璇锋鏌ibopus.js鏂囦欢鏄惁瀛樺湪涓旀纭? ${err.message}`, 'error');
    }
}


// 鍒涘缓涓€涓狾pus缂栫爜鍣?
let opusEncoder = null;
export function initOpusEncoder() {
    try {
        if (opusEncoder) {
            return opusEncoder; // 宸茬粡鍒濆鍖栬繃
        }

        if (!window.ModuleInstance) {
            log('鏃犳硶鍒涘缓Opus缂栫爜鍣細ModuleInstance涓嶅彲鐢?, 'error');
            return;
        }

        // 鍒濆鍖栦竴涓狾pus缂栫爜鍣?
        const mod = window.ModuleInstance;
        const sampleRate = 16000; // 16kHz閲囨牱鐜?
        const channels = 1;       // 鍗曞０閬?
        const application = 2048; // OPUS_APPLICATION_VOIP = 2048

        // 鍒涘缓缂栫爜鍣?
        opusEncoder = {
            channels: channels,
            sampleRate: sampleRate,
            frameSize: 960, // 60ms @ 16kHz = 60 * 16 = 960 samples
            maxPacketSize: 4000, // 鏈€澶у寘澶у皬
            module: mod,

            // 鍒濆鍖栫紪鐮佸櫒
            init: function () {
                try {
                    // 鑾峰彇缂栫爜鍣ㄥぇ灏?
                    const encoderSize = mod._opus_encoder_get_size(this.channels);
                    log(`Opus缂栫爜鍣ㄥぇ灏? ${encoderSize}瀛楄妭`, 'info');

                    // 鍒嗛厤鍐呭瓨
                    this.encoderPtr = mod._malloc(encoderSize);
                    if (!this.encoderPtr) {
                        throw new Error("鏃犳硶鍒嗛厤缂栫爜鍣ㄥ唴瀛?);
                    }

                    // 鍒濆鍖栫紪鐮佸櫒
                    const err = mod._opus_encoder_init(
                        this.encoderPtr,
                        this.sampleRate,
                        this.channels,
                        application
                    );

                    if (err < 0) {
                        throw new Error(`Opus缂栫爜鍣ㄥ垵濮嬪寲澶辫触: ${err}`);
                    }

                    // 璁剧疆浣嶇巼 (16kbps)
                    mod._opus_encoder_ctl(this.encoderPtr, 4002, 16000); // OPUS_SET_BITRATE

                    // 璁剧疆澶嶆潅搴?(0-10, 瓒婇珮璐ㄩ噺瓒婂ソ浣咰PU浣跨敤瓒婂)
                    mod._opus_encoder_ctl(this.encoderPtr, 4010, 5);     // OPUS_SET_COMPLEXITY

                    // 璁剧疆浣跨敤DTX (涓嶄紶杈撻潤闊冲抚)
                    mod._opus_encoder_ctl(this.encoderPtr, 4016, 1);     // OPUS_SET_DTX

                    log("Opus缂栫爜鍣ㄥ垵濮嬪寲鎴愬姛", 'success');
                    return true;
                } catch (error) {
                    if (this.encoderPtr) {
                        mod._free(this.encoderPtr);
                        this.encoderPtr = null;
                    }
                    log(`Opus缂栫爜鍣ㄥ垵濮嬪寲澶辫触: ${error.message}`, 'error');
                    return false;
                }
            },

            // 缂栫爜PCM鏁版嵁涓篛pus
            encode: function (pcmData) {
                if (!this.encoderPtr) {
                    if (!this.init()) {
                        return null;
                    }
                }

                try {
                    const mod = this.module;

                    // 涓篜CM鏁版嵁鍒嗛厤鍐呭瓨
                    const pcmPtr = mod._malloc(pcmData.length * 2); // 2瀛楄妭/int16

                    // 灏哖CM鏁版嵁澶嶅埗鍒癏EAP
                    for (let i = 0; i < pcmData.length; i++) {
                        mod.HEAP16[(pcmPtr >> 1) + i] = pcmData[i];
                    }

                    // 涓鸿緭鍑哄垎閰嶅唴瀛?
                    const outPtr = mod._malloc(this.maxPacketSize);

                    // 杩涜缂栫爜
                    const encodedLen = mod._opus_encode(
                        this.encoderPtr,
                        pcmPtr,
                        this.frameSize,
                        outPtr,
                        this.maxPacketSize
                    );

                    if (encodedLen < 0) {
                        throw new Error(`Opus缂栫爜澶辫触: ${encodedLen}`);
                    }

                    // 澶嶅埗缂栫爜鍚庣殑鏁版嵁
                    const opusData = new Uint8Array(encodedLen);
                    for (let i = 0; i < encodedLen; i++) {
                        opusData[i] = mod.HEAPU8[outPtr + i];
                    }

                    // 閲婃斁鍐呭瓨
                    mod._free(pcmPtr);
                    mod._free(outPtr);

                    return opusData;
                } catch (error) {
                    log(`Opus缂栫爜鍑洪敊: ${error.message}`, 'error');
                    return null;
                }
            },

            // 閿€姣佺紪鐮佸櫒
            destroy: function () {
                if (this.encoderPtr) {
                    this.module._free(this.encoderPtr);
                    this.encoderPtr = null;
                }
            }
        };

        opusEncoder.init();
        return opusEncoder;
    } catch (error) {
        log(`鍒涘缓Opus缂栫爜鍣ㄥけ璐? ${error.message}`, 'error');
        return false;
    }
}