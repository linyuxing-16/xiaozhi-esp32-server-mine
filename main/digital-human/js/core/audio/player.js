// 闊抽鎾斁妯″潡
import BlockingQueue from '../../utils/blocking-queue.js?v=0206';
import { log } from '../../utils/logger.js?v=0206';
import { createStreamingContext } from './stream-context.js?v=0206';

// 闊抽鎾斁鍣ㄧ被
export class AudioPlayer {
    constructor() {
        // 闊抽鍙傛暟
        this.SAMPLE_RATE = 16000;
        this.CHANNELS = 1;
        this.FRAME_SIZE = 960;
        this.MIN_AUDIO_DURATION = 0.12;

        // 鐘舵€?
        this.audioContext = null;
        this.opusDecoder = null;
        this.streamingContext = null;
        this.queue = new BlockingQueue();
        this.isPlaying = false;
    }

    // 鑾峰彇鎴栧垱寤篈udioContext
    getAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.SAMPLE_RATE,
                latencyHint: 'interactive'
            });
            log('鍒涘缓闊抽涓婁笅鏂囷紝閲囨牱鐜? ' + this.SAMPLE_RATE + 'Hz', 'debug');
        }
        return this.audioContext;
    }

    // 鍒濆鍖朞pus瑙ｇ爜鍣?
    async initOpusDecoder() {
        if (this.opusDecoder) return this.opusDecoder;

        try {
            if (typeof window.ModuleInstance === 'undefined') {
                if (typeof Module !== 'undefined') {
                    window.ModuleInstance = Module;
                    log('浣跨敤鍏ㄥ眬Module浣滀负ModuleInstance', 'info');
                } else {
                    throw new Error('Opus搴撴湭鍔犺浇锛孧oduleInstance鍜孧odule瀵硅薄閮戒笉瀛樺湪');
                }
            }

            const mod = window.ModuleInstance;

            this.opusDecoder = {
                channels: this.CHANNELS,
                rate: this.SAMPLE_RATE,
                frameSize: this.FRAME_SIZE,
                module: mod,
                decoderPtr: null,

                init: function () {
                    if (this.decoderPtr) return true;

                    const decoderSize = mod._opus_decoder_get_size(this.channels);
                    log(`Opus瑙ｇ爜鍣ㄥぇ灏? ${decoderSize}瀛楄妭`, 'debug');

                    this.decoderPtr = mod._malloc(decoderSize);
                    if (!this.decoderPtr) {
                        throw new Error("鏃犳硶鍒嗛厤瑙ｇ爜鍣ㄥ唴瀛?);
                    }

                    const err = mod._opus_decoder_init(
                        this.decoderPtr,
                        this.rate,
                        this.channels
                    );

                    if (err < 0) {
                        this.destroy();
                        throw new Error(`Opus瑙ｇ爜鍣ㄥ垵濮嬪寲澶辫触: ${err}`);
                    }

                    log("Opus瑙ｇ爜鍣ㄥ垵濮嬪寲鎴愬姛", 'success');
                    return true;
                },

                decode: function (opusData) {
                    if (!this.decoderPtr) {
                        if (!this.init()) {
                            throw new Error("瑙ｇ爜鍣ㄦ湭鍒濆鍖栦笖鏃犳硶鍒濆鍖?);
                        }
                    }

                    try {
                        const mod = this.module;

                        const opusPtr = mod._malloc(opusData.length);
                        mod.HEAPU8.set(opusData, opusPtr);

                        const pcmPtr = mod._malloc(this.frameSize * 2);

                        const decodedSamples = mod._opus_decode(
                            this.decoderPtr,
                            opusPtr,
                            opusData.length,
                            pcmPtr,
                            this.frameSize,
                            0
                        );

                        if (decodedSamples < 0) {
                            mod._free(opusPtr);
                            mod._free(pcmPtr);
                            throw new Error(`Opus瑙ｇ爜澶辫触: ${decodedSamples}`);
                        }

                        const decodedData = new Int16Array(decodedSamples);
                        for (let i = 0; i < decodedSamples; i++) {
                            decodedData[i] = mod.HEAP16[(pcmPtr >> 1) + i];
                        }

                        mod._free(opusPtr);
                        mod._free(pcmPtr);

                        return decodedData;
                    } catch (error) {
                        log(`Opus瑙ｇ爜閿欒: ${error.message}`, 'error');
                        return new Int16Array(0);
                    }
                },

                destroy: function () {
                    if (this.decoderPtr) {
                        this.module._free(this.decoderPtr);
                        this.decoderPtr = null;
                    }
                }
            };

            if (!this.opusDecoder.init()) {
                throw new Error("Opus瑙ｇ爜鍣ㄥ垵濮嬪寲澶辫触");
            }

            return this.opusDecoder;

        } catch (error) {
            log(`Opus瑙ｇ爜鍣ㄥ垵濮嬪寲澶辫触: ${error.message}`, 'error');
            this.opusDecoder = null;
            throw error;
        }
    }

    // 鍚姩闊抽缂撳啿
    async startAudioBuffering() {
        log("寮€濮嬮煶棰戠紦鍐?..", 'info');

        this.initOpusDecoder().catch(error => {
            log(`棰勫垵濮嬪寲Opus瑙ｇ爜鍣ㄥけ璐? ${error.message}`, 'warning');
        });

        const timeout = 400;
        while (true) {
            const packets = await this.queue.dequeue(
                6,
                timeout,
                (count) => {
                    log(`缂撳啿瓒呮椂锛屽綋鍓嶇紦鍐插寘鏁? ${count}锛屽紑濮嬫挱鏀綻, 'info');
                }
            );
            if (packets.length) {
                log(`宸茬紦鍐?${packets.length} 涓煶棰戝寘锛屽紑濮嬫挱鏀綻, 'info');
                this.streamingContext.pushAudioBuffer(packets);
            }

            while (true) {
                const data = await this.queue.dequeue(99, 30);
                if (data.length) {
                    this.streamingContext.pushAudioBuffer(data);
                } else {
                    break;
                }
            }
        }
    }

    // 鎾斁宸茬紦鍐茬殑闊抽
    async playBufferedAudio() {
        try {
            this.audioContext = this.getAudioContext();

            if (!this.opusDecoder) {
                log('鍒濆鍖朞pus瑙ｇ爜鍣?..', 'info');
                try {
                    this.opusDecoder = await this.initOpusDecoder();
                    if (!this.opusDecoder) {
                        throw new Error('瑙ｇ爜鍣ㄥ垵濮嬪寲澶辫触');
                    }
                    log('Opus瑙ｇ爜鍣ㄥ垵濮嬪寲鎴愬姛', 'success');
                } catch (error) {
                    log('Opus瑙ｇ爜鍣ㄥ垵濮嬪寲澶辫触: ' + error.message, 'error');
                    this.isPlaying = false;
                    return;
                }
            }

            if (!this.streamingContext) {
                this.streamingContext = createStreamingContext(
                    this.opusDecoder,
                    this.audioContext,
                    this.SAMPLE_RATE,
                    this.CHANNELS,
                    this.MIN_AUDIO_DURATION
                );
            }

            this.streamingContext.decodeOpusFrames();
            this.streamingContext.startPlaying();

        } catch (error) {
            log(`鎾斁宸茬紦鍐茬殑闊抽鍑洪敊: ${error.message}`, 'error');
            this.isPlaying = false;
            this.streamingContext = null;
        }
    }

    // 娣诲姞闊抽鏁版嵁鍒伴槦鍒?
    enqueueAudioData(opusData) {
        if (opusData.length > 0) {
            this.queue.enqueue(opusData);
        } else {
            log('鏀跺埌绌洪煶棰戞暟鎹抚锛屽彲鑳芥槸缁撴潫鏍囧織', 'warning');
            if (this.isPlaying && this.streamingContext) {
                this.streamingContext.endOfStream = true;
            }
        }
    }

    // 棰勫姞杞借В鐮佸櫒
    async preload() {
        log('棰勫姞杞絆pus瑙ｇ爜鍣?..', 'info');
        try {
            await this.initOpusDecoder();
            log('Opus瑙ｇ爜鍣ㄩ鍔犺浇鎴愬姛', 'success');
        } catch (error) {
            log(`Opus瑙ｇ爜鍣ㄩ鍔犺浇澶辫触: ${error.message}锛屽皢鍦ㄩ渶瑕佹椂閲嶈瘯`, 'warning');
        }
    }

    // 鍚姩鎾斁绯荤粺
    async start() {
        await this.preload();
        this.playBufferedAudio();
        this.startAudioBuffering();
    }

    // 鑾峰彇闊抽鍖呯粺璁′俊鎭?
    getAudioStats() {
        if (!this.streamingContext) {
            return {
                pendingDecode: 0,
                pendingPlay: 0,
                totalPending: 0
            };
        }

        const pendingDecode = this.streamingContext.getPendingDecodeCount();
        const pendingPlay = this.streamingContext.getPendingPlayCount();

        return {
            pendingDecode,  // 寰呰В鐮佸寘鏁?
            pendingPlay,    // 寰呮挱鏀惧寘鏁?
            totalPending: pendingDecode + pendingPlay  // 鎬诲緟澶勭悊鍖呮暟
        };
    }

    // 娓呯┖鎵€鏈夐煶棰戠紦鍐插苟鍋滄鎾斁
    clearAllAudio() {
        log('AudioPlayer: 娓呯┖鎵€鏈夐煶棰?, 'info');

        // 娓呯┖鎺ユ敹闃熷垪锛堜娇鐢╟lear鏂规硶淇濇寔瀵硅薄寮曠敤锛?
        this.queue.clear();

        // 娓呯┖娴佷笂涓嬫枃鐨勬墍鏈夌紦鍐?
        if (this.streamingContext) {
            this.streamingContext.clearAllBuffers();
        }

        log('AudioPlayer: 闊抽宸叉竻绌?, 'success');
    }
}

// 鍒涘缓鍗曚緥
let audioPlayerInstance = null;

export function getAudioPlayer() {
    if (!audioPlayerInstance) {
        audioPlayerInstance = new AudioPlayer();
    }
    return audioPlayerInstance;
}
