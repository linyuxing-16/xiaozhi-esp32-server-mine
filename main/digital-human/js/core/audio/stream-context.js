import BlockingQueue from '../../utils/blocking-queue.js?v=0206';
import { log } from '../../utils/logger.js?v=0206';

// 闊抽娴佹挱鏀句笂涓嬫枃绫?
export class StreamingContext {
    constructor(opusDecoder, audioContext, sampleRate, channels, minAudioDuration) {
        this.opusDecoder = opusDecoder;
        this.audioContext = audioContext;

        // 闊抽鍙傛暟
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.minAudioDuration = minAudioDuration;

        // 鍒濆鍖栭槦鍒楀拰鐘舵€?
        this.queue = [];          // 宸茶В鐮佺殑PCM闃熷垪銆傛鍦ㄦ挱鏀?
        this.activeQueue = new BlockingQueue(); // 宸茶В鐮佺殑PCM闃熷垪銆傚噯澶囨挱鏀?
        this.pendingAudioBufferQueue = [];  // 寰呭鐞嗙殑缂撳瓨闃熷垪
        this.audioBufferQueue = new BlockingQueue();  // 缂撳瓨闃熷垪
        this.playing = false;     // 鏄惁姝ｅ湪鎾斁
        this.endOfStream = false; // 鏄惁鏀跺埌缁撴潫淇″彿
        this.source = null;       // 褰撳墠闊抽婧?
        this.totalSamples = 0;    // 绱Н鐨勬€绘牱鏈暟
        this.lastPlayTime = 0;    // 涓婃鎾斁鐨勬椂闂存埑
        this.scheduledEndTime = 0; // 宸茶皟搴﹂煶棰戠殑缁撴潫鏃堕棿

        // 鍒濆鍖栧垎鏋愬櫒鑺傜偣锛堜緵Live2D浣跨敤锛?
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
    }

    // 缂撳瓨闊抽鏁扮粍
    pushAudioBuffer(item) {
        this.audioBufferQueue.enqueue(...item);
    }

    // 鑾峰彇闇€瑕佸鐞嗙紦瀛橀槦鍒楋紝鍗曠嚎绋嬶細鍦╝udioBufferQueue涓€鐩存洿鏂扮殑鐘舵€佷笅涓嶄細鍑虹幇瀹夊叏闂
    async getPendingAudioBufferQueue() {
        // 绛夊緟鏁版嵁鍒拌揪骞惰幏鍙?
        const data = await this.audioBufferQueue.dequeue();
        // 璧嬪€肩粰寰呭鐞嗛槦鍒?
        this.pendingAudioBufferQueue = data;
    }

    // 鑾峰彇姝ｅ湪鎾斁宸茶В鐮佺殑PCM闃熷垪锛屽崟绾跨▼锛氬湪activeQueue涓€鐩存洿鏂扮殑鐘舵€佷笅涓嶄細鍑虹幇瀹夊叏闂
    async getQueue(minSamples) {
        const num = minSamples - this.queue.length > 0 ? minSamples - this.queue.length : 1;

        // 绛夊緟鏁版嵁骞惰幏鍙?
        const tempArray = await this.activeQueue.dequeue(num);
        this.queue.push(...tempArray);
    }

    // 灏咺nt16闊抽鏁版嵁杞崲涓篎loat32闊抽鏁版嵁
    convertInt16ToFloat32(int16Data) {
        const float32Data = new Float32Array(int16Data.length);
        for (let i = 0; i < int16Data.length; i++) {
            // 灏哰-32768,32767]鑼冨洿杞崲涓篬-1,1]锛岀粺涓€浣跨敤32768.0閬垮厤涓嶅绉板け鐪?
            float32Data[i] = int16Data[i] / 32768.0;
        }
        return float32Data;
    }

    // 鑾峰彇寰呰В鐮佸寘鏁?
    getPendingDecodeCount() {
        return this.audioBufferQueue.length + this.pendingAudioBufferQueue.length;
    }

    // 鑾峰彇寰呮挱鏀炬牱鏈暟锛堣浆鎹负鍖呮暟锛屾瘡鍖?60鏍锋湰锛?
    getPendingPlayCount() {
        // 璁＄畻宸插湪闃熷垪涓殑鏍锋湰
        const queuedSamples = this.activeQueue.length + this.queue.length;

        // 璁＄畻宸茶皟搴︿絾鏈挱鏀剧殑鏍锋湰锛堝湪Web Audio缂撳啿鍖轰腑锛?
        let scheduledSamples = 0;
        if (this.playing && this.scheduledEndTime) {
            const currentTime = this.audioContext.currentTime;
            const remainingTime = Math.max(0, this.scheduledEndTime - currentTime);
            scheduledSamples = Math.floor(remainingTime * this.sampleRate);
        }

        const totalSamples = queuedSamples + scheduledSamples;
        return Math.ceil(totalSamples / 960);
    }

    // 娓呯┖鎵€鏈夐煶棰戠紦鍐?
    clearAllBuffers() {
        log('娓呯┖鎵€鏈夐煶棰戠紦鍐?, 'info');

        // 娓呯┖鎵€鏈夐槦鍒楋紙浣跨敤clear鏂规硶淇濇寔瀵硅薄寮曠敤锛?
        this.audioBufferQueue.clear();
        this.pendingAudioBufferQueue = [];
        this.activeQueue.clear();
        this.queue = [];

        // 鍋滄褰撳墠鎾斁鐨勯煶棰戞簮
        if (this.source) {
            try {
                this.source.stop();
                this.source.disconnect();
            } catch (e) {
                // 蹇界暐宸茬粡鍋滄鐨勯敊璇?
            }
            this.source = null;
        }

        // 閲嶇疆鐘舵€?
        this.playing = false;
        this.scheduledEndTime = this.audioContext.currentTime;
        this.totalSamples = 0;

        log('闊抽缂撳啿宸叉竻绌?, 'success');
    }

    // 鑾峰彇鍒嗘瀽鍣ㄨ妭鐐癸紙渚汱ive2D浣跨敤锛?
    getAnalyser() {
        return this.analyser;
    }

    // 灏哋pus鏁版嵁瑙ｇ爜涓篜CM
    async decodeOpusFrames() {
        if (!this.opusDecoder) {
            log('Opus瑙ｇ爜鍣ㄦ湭鍒濆鍖栵紝鏃犳硶瑙ｇ爜', 'error');
            return;
        } else {
            log('Opus瑙ｇ爜鍣ㄥ惎鍔?, 'info');
        }

        while (true) {
            let decodedSamples = [];
            for (const frame of this.pendingAudioBufferQueue) {
                try {
                    // 浣跨敤Opus瑙ｇ爜鍣ㄨВ鐮?
                    const frameData = this.opusDecoder.decode(frame);
                    if (frameData && frameData.length > 0) {
                        // 杞崲涓篎loat32
                        const floatData = this.convertInt16ToFloat32(frameData);
                        // 浣跨敤寰幆鏇夸唬灞曞紑杩愮畻绗?
                        for (let i = 0; i < floatData.length; i++) {
                            decodedSamples.push(floatData[i]);
                        }
                    }
                } catch (error) {
                    log("Opus瑙ｇ爜澶辫触: " + error.message, 'error');
                }
            }

            if (decodedSamples.length > 0) {
                // 浣跨敤寰幆鏇夸唬灞曞紑杩愮畻绗?
                for (let i = 0; i < decodedSamples.length; i++) {
                    this.activeQueue.enqueue(decodedSamples[i]);
                }
                this.totalSamples += decodedSamples.length;
            } else {
                log('娌℃湁鎴愬姛瑙ｇ爜鐨勬牱鏈?, 'warning');
            }
            await this.getPendingAudioBufferQueue();
        }
    }

    // 寮€濮嬫挱鏀鹃煶棰?
    async startPlaying() {
        this.scheduledEndTime = this.audioContext.currentTime; // 璺熻釜宸茶皟搴﹂煶棰戠殑缁撴潫鏃堕棿

        while (true) {
            // 鍒濆缂撳啿锛氱瓑寰呰冻澶熺殑鏍锋湰鍐嶅紑濮嬫挱鏀?
            const minSamples = this.sampleRate * this.minAudioDuration * 2;
            if (!this.playing && this.queue.length < minSamples) {
                await this.getQueue(minSamples);
            }
            this.playing = true;

            // 鎸佺画鎾斁闃熷垪涓殑闊抽锛屾瘡娆℃挱鏀句竴涓皬鍧?
            while (this.playing && this.queue.length > 0) {
                // 姣忔鎾斁120ms鐨勯煶棰戯紙2涓狾pus鍖咃級
                const playDuration = 0.12;
                const targetSamples = Math.floor(this.sampleRate * playDuration);
                const actualSamples = Math.min(this.queue.length, targetSamples);

                if (actualSamples === 0) break;

                const currentSamples = this.queue.splice(0, actualSamples);
                const audioBuffer = this.audioContext.createBuffer(this.channels, currentSamples.length, this.sampleRate);
                audioBuffer.copyToChannel(new Float32Array(currentSamples), 0);

                // 鍒涘缓闊抽婧?
                this.source = this.audioContext.createBufferSource();
                this.source.buffer = audioBuffer;

                // 绮剧‘璋冨害鎾斁鏃堕棿
                const currentTime = this.audioContext.currentTime;
                const startTime = Math.max(this.scheduledEndTime, currentTime);

                // 杩炴帴鍒板垎鏋愬櫒鍜岃緭鍑?
                this.source.connect(this.analyser);
                this.source.connect(this.audioContext.destination);

                log(`璋冨害鎾斁 ${currentSamples.length} 涓牱鏈紝绾?${(currentSamples.length / this.sampleRate).toFixed(2)} 绉抈, 'debug');
                this.source.start(startTime);

                // 鏇存柊涓嬩竴涓煶棰戝潡鐨勮皟搴︽椂闂?
                const duration = audioBuffer.duration;
                this.scheduledEndTime = startTime + duration;
                this.lastPlayTime = startTime;

                // 濡傛灉闃熷垪涓暟鎹笉瓒筹紝绛夊緟鏂版暟鎹?
                if (this.queue.length < targetSamples) {
                    break;
                }
            }

            // 绛夊緟鏂版暟鎹?
            await this.getQueue(minSamples);
        }
    }
}

// 鍒涘缓streamingContext瀹炰緥鐨勫伐鍘傚嚱鏁?
export function createStreamingContext(opusDecoder, audioContext, sampleRate, channels, minAudioDuration) {
    return new StreamingContext(opusDecoder, audioContext, sampleRate, channels, minAudioDuration);
}