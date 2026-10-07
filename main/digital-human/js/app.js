// 涓诲簲鐢ㄥ叆鍙?
import { checkOpusLoaded, initOpusEncoder } from './core/audio/opus-codec.js?v=0206';
import { getAudioPlayer } from './core/audio/player.js?v=0206';
import { checkMicrophoneAvailability, isHttpNonLocalhost } from './core/audio/recorder.js?v=0206';
import { initMcpTools } from './core/mcp/tools.js?v=0206';
import { startWakewordBridgeListener } from './core/network/wakeword-bridge.js?v=0206';
import { uiController } from './ui/controller.js?v=0206';
import { log } from './utils/logger.js?v=0206';

// 杈呭姪鍑芥暟锛氬皢Base64鏁版嵁杞崲涓築lob
function dataURItoBlob(dataURI) {
    const byteString = atob(dataURI.split(',')[1]);
    const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeString });
}

// 搴旂敤绫?
class App {
    constructor() {
        this.uiController = null;
        this.audioPlayer = null;
        this.live2dManager = null;
        this.cameraStream = null;
        this.currentFacingMode = 'user';
    }

    // 鍒濆鍖栧簲鐢?
    async init() {
        log('姝ｅ湪鍒濆鍖栧簲鐢?..', 'info');
        // 鍒濆鍖朥I鎺у埗鍣?
        this.uiController = uiController;
        this.uiController.init();
        // 妫€鏌pus搴?
        checkOpusLoaded();
        // 鍒濆鍖朞pus缂栫爜鍣?
        initOpusEncoder();
        // 鍒濆鍖栭煶棰戞挱鏀惧櫒
        this.audioPlayer = getAudioPlayer();
        await this.audioPlayer.start();
        // 鍒濆鍖朚CP宸ュ叿
        initMcpTools();
        // 鍒濆鍖栨湰鍦板敜閱掍簨浠剁洃鍚?
        startWakewordBridgeListener();
        // 妫€鏌ラ害鍏嬮鍙敤鎬?
        await this.checkMicrophoneAvailability();
        // 妫€鏌ユ憚鍍忓ご鍙敤鎬?
        this.checkCameraAvailability();
        // 鍒濆鍖朙ive2D
        await this.initLive2D();
        // 鍒濆鍖栨憚鍍忓ご
        this.initCamera();
        // 鍏抽棴鍔犺浇loading
        this.setModelLoadingStatus(false);
        log('搴旂敤鍒濆鍖栧畬鎴?, 'success');
    }

    // 鍒濆鍖朙ive2D
    async initLive2D() {
        try {
            // 妫€鏌ive2DManager鏄惁宸插姞杞?
            if (typeof window.Live2DManager === 'undefined') {
                throw new Error('Live2DManager鏈姞杞斤紝璇锋鏌ヨ剼鏈紩鍏ラ『搴?);
            }
            this.live2dManager = new window.Live2DManager();
            await this.live2dManager.initializeLive2D();
            // 鏇存柊UI鐘舵€?
            const live2dStatus = document.getElementById('live2dStatus');
            if (live2dStatus) {
                live2dStatus.textContent = '鈼?宸插姞杞?;
                live2dStatus.className = 'status loaded';
            }
            log('Live2D鍒濆鍖栧畬鎴?, 'success');
        } catch (error) {
            log(`Live2D鍒濆鍖栧け璐? ${error.message}`, 'error');
            // 鏇存柊UI鐘舵€?
            const live2dStatus = document.getElementById('live2dStatus');
            if (live2dStatus) {
                live2dStatus.textContent = '鈼?鍔犺浇澶辫触';
                live2dStatus.className = 'status error';
            }
        }
    }

    // 璁剧疆model鍔犺浇鐘舵€?
    setModelLoadingStatus(isLoading) {
        const modelLoading = document.getElementById('modelLoading');
        if (modelLoading) {
            modelLoading.style.display = isLoading ? 'flex' : 'none';
        }
    }

    /**
     * 妫€鏌ラ害鍏嬮鍙敤鎬?
     * 鍦ㄥ簲鐢ㄥ垵濮嬪寲鏃惰皟鐢紝妫€鏌ラ害鍏嬮鏄惁鍙敤骞舵洿鏂癠I鐘舵€?
     */
    async checkMicrophoneAvailability() {
        try {
            const isAvailable = await checkMicrophoneAvailability();
            const isHttp = isHttpNonLocalhost();
            // 淇濆瓨鍙敤鎬х姸鎬佸埌鍏ㄥ眬鍙橀噺
            window.microphoneAvailable = isAvailable;
            window.isHttpNonLocalhost = isHttp;
            // 鏇存柊UI
            if (this.uiController) {
                this.uiController.updateMicrophoneAvailability(isAvailable, isHttp);
            }
            log(`楹﹀厠椋庡彲鐢ㄦ€ф鏌ュ畬鎴? ${isAvailable ? '鍙敤' : '涓嶅彲鐢?}`, isAvailable ? 'success' : 'warning');
        } catch (error) {
            log(`妫€鏌ラ害鍏嬮鍙敤鎬уけ璐? ${error.message}`, 'error');
            // 榛樿璁剧疆涓轰笉鍙敤
            window.microphoneAvailable = false;
            window.isHttpNonLocalhost = isHttpNonLocalhost();
            if (this.uiController) {
                this.uiController.updateMicrophoneAvailability(false, window.isHttpNonLocalhost);
            }
        }
    }

    // 妫€鏌ユ憚鍍忓ご鍙敤鎬?
    checkCameraAvailability() {
        window.cameraAvailable = true;
        log('鎽勫儚澶村彲鐢ㄦ€ф鏌ュ畬鎴? 榛樿宸茬粦瀹氶獙璇佺爜', 'success');
    }

    // 鍒濆鍖栨憚鍍忓ご
    async initCamera() {
        const cameraContainer = document.getElementById('cameraContainer');
        const cameraVideo = document.getElementById('cameraVideo');
        const cameraSwitch = document.getElementById('cameraSwitch');
        const cameraSwitchMask = document.getElementById('cameraSwitchMask');
        const dialBtn = document.getElementById('dialBtn');

        if (!cameraContainer || !cameraVideo) {
            log('鎽勫儚澶村厓绱犳湭鎵惧埌锛岃烦杩囧垵濮嬪寲', 'warning');
            return Promise.resolve(false);
        }

        let isDragging = false;
        let currentX, currentY, initialX, initialY;
        let xOffset = 0, yOffset = 0;

        cameraContainer.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
        cameraContainer.addEventListener('touchstart', dragStart, { passive: false });
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', dragEnd);

        function dragStart(e) {
            if (e.type === 'touchstart') {
                initialX = e.touches[0].clientX - xOffset;
                initialY = e.touches[0].clientY - yOffset;
            } else {
                initialX = e.clientX - xOffset;
                initialY = e.clientY - yOffset;
            }
            isDragging = true;
            cameraContainer.classList.add('dragging');
        }

        function drag(e) {
            if (isDragging) {
                e.preventDefault();
                if (e.type === 'touchmove') {
                    currentX = e.touches[0].clientX - initialX;
                    currentY = e.touches[0].clientY - initialY;
                } else {
                    currentX = e.clientX - initialX;
                    currentY = e.clientY - initialY;
                }
                xOffset = currentX;
                yOffset = currentY;
                cameraContainer.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
            }
        }

        function dragEnd() {
            initialX = currentX;
            initialY = currentY;
            isDragging = false;
            cameraContainer.classList.remove('dragging');
        }

        return new Promise((resolve) => {
            window.startCamera = async () => {
                try {
                    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                        log('娴忚鍣ㄤ笉鏀寔鎽勫儚澶碅PI', 'warning');
                        return false;
                    }
                    log('姝ｅ湪璇锋眰鎽勫儚澶存潈闄?..', 'info');
                    this.cameraStream = await navigator.mediaDevices.getUserMedia({
                        video: { width: 180, height: 240, facingMode: this.currentFacingMode },
                        audio: false
                    });
                    cameraVideo.srcObject = this.cameraStream;
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const videoDevices = devices.filter(device => device.kind === 'videoinput');
                    if (videoDevices.length > 1) {
                        if (cameraSwitch) cameraSwitch.classList.add('active'); 
                    }
                    cameraContainer.classList.add('active');

                    // 鍒囨崲鏃舵寕鏂儏鍐?
                    const hasActive = dialBtn.classList.contains('dial-active');
                    if (!hasActive) {
                        cameraContainer.classList.remove('active');
                        cameraSwitch.classList.remove('active');
                        window.stopCamera();
                    }
                    log('鎽勫儚澶村凡鍚姩', 'success');
                    return true;
                } catch (error) {
                    log(`鍚姩鎽勫儚澶村け璐? ${error.name} - ${error.message}`, 'error');
                    if (error.name === 'NotAllowedError') {
                        log('鎽勫儚澶存潈闄愯鎷掔粷锛岃妫€鏌ユ祻瑙堝櫒璁剧疆', 'warning');
                    } else if (error.name === 'NotFoundError') {
                        log('鏈壘鍒版憚鍍忓ご璁惧', 'warning');
                    } else if (error.name === 'NotReadableError') {
                        log('鎽勫儚澶村凡琚叾浠栫▼搴忓崰鐢?, 'warning');
                    }
                    return false;
                }
            };

            window.stopCamera = () => {
                if (this.cameraStream) {
                    this.cameraStream.getTracks().forEach(track => track.stop());
                    this.cameraStream = null;
                    cameraVideo.srcObject = null;
                    log('鎽勫儚澶村凡鍏抽棴', 'info');
                }
                // 鎽勫儚澶村叧闂椂涓杩涜涓殑褰曞儚浼氳瘽
                this._abortVideoRecording('鎽勫儚澶村凡鍏抽棴');
            };

            // ============ VAD瑙﹀彂褰曞儚锛歁ediaRecorder 褰曞埗涓庝笂浼?============

            // 褰曞儚鏈€鐭椂闀?姣)锛氱煭浜庢涓㈠純锛岄槻璇Е锛堜笌鏈嶅姟绔?min_duration_ms 瀵瑰簲锛?
            const VIDEO_MIN_DURATION_MS = 800;

            // 闅愮鎻愮ず锛氬綍鍍忎腑鐨勭孩鐐硅鏍?
            this._showRecordingBadge = () => {
                let badge = document.getElementById('recordingBadge');
                if (!badge && cameraContainer) {
                    badge = document.createElement('div');
                    badge.id = 'recordingBadge';
                    badge.style.cssText = 'position:absolute;top:6px;right:6px;display:flex;align-items:center;gap:4px;' +
                        'background:rgba(0,0,0,0.55);color:#fff;font-size:10px;padding:2px 6px;border-radius:10px;z-index:9999;pointer-events:none;';
                    badge.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#ff3b30;display:inline-block;animation:recblink 1s infinite;"></span>REC';
                    const style = document.createElement('style');
                    style.textContent = '@keyframes recblink{0%,100%{opacity:1}50%{opacity:0.25}}';
                    document.head.appendChild(style);
                    cameraContainer.appendChild(badge);
                }
                if (badge) badge.style.display = 'flex';
            };
            this._hideRecordingBadge = () => {
                const badge = document.getElementById('recordingBadge');
                if (badge) badge.style.display = 'none';
            };

            // 涓褰曞儚锛堜笉浜у嚭瑙嗛锛岄潤榛橈級
            this._abortVideoRecording = () => {
                if (this.videoRecording) {
                    try { clearTimeout(this.videoRecording.timer); } catch (e) { /* 蹇界暐 */ }
                    try { if (this.videoRecording.recorder.state !== 'inactive') this.videoRecording.recorder.stop(); } catch (e) { /* 蹇界暐 */ }
                    this.videoRecording.aborted = true;
                    this.videoRecording = null;
                    this._hideRecordingBadge();
                }
            };

            /**
             * 褰曞埗涓€娈佃棰戯紙VAD瑙﹀彂褰曞儚鏍稿績鍏ュ彛锛?
             * @param {object} opts { requestId, maxDurationMs }
             * @returns {Promise<Blob|null>} 褰曞儚Blob锛涜繃鐭垨澶辫触杩斿洖null
             */
            window.recordVideo = ({ requestId, maxDurationMs = 5000 } = {}) => {
                return new Promise((resolve) => {
                    if (!this.cameraStream) {
                        log('鏃犳硶褰曞儚锛氭憚鍍忓ご鏈惎鍔紙闈欓粯闄嶇骇涓虹函鏂囨湰锛?, 'warning');
                        resolve(null);
                        return;
                    }
                    if (typeof MediaRecorder === 'undefined') {
                        log('娴忚鍣ㄤ笉鏀寔MediaRecorder褰曞儚', 'warning');
                        resolve(null);
                        return;
                    }
                    if (this.videoRecording) {
                        log('宸叉湁褰曞儚杩涜涓紝蹇界暐閲嶅瑙﹀彂', 'info');
                        resolve(null);
                        return;
                    }

                    // 閫夋嫨娴忚鍣ㄦ敮鎸佺殑瀹瑰櫒鏍煎紡锛氫紭鍏坵ebm(Safari鍥為€€mp4)
                    const candidates = [
                        'video/webm;codecs=vp9',
                        'video/webm;codecs=vp8',
                        'video/webm',
                        'video/mp4'
                    ];
                    const mimeType = candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
                    const recorder = new MediaRecorder(this.cameraStream, mimeType ? { mimeType } : undefined);
                    const chunks = [];
                    const startTime = Date.now();
                    const session = {
                        recorder, requestId, startTime,
                        timer: null, aborted: false, finished: false
                    };
                    this.videoRecording = session;

                    recorder.ondataavailable = (e) => {
                        if (e.data && e.data.size > 0) chunks.push(e.data);
                    };
                    recorder.onstop = () => {
                        session.finished = true;
                        this.videoRecording = null;
                        this._hideRecordingBadge();
                        const durationMs = Date.now() - startTime;
                        if (session.aborted) {
                            resolve(null);
                            return;
                        }
                        if (durationMs < VIDEO_MIN_DURATION_MS) {
                            log('褰曞儚鏃堕暱杩囩煭锛屼涪寮?闃茶瑙?', 'info');
                            resolve(null);
                            return;
                        }
                        const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
                        log('褰曞儚瀹屾垚: ' + (blob.size / 1024).toFixed(1) + 'KB, ' + durationMs + 'ms', 'success');
                        resolve(blob);
                    };
                    recorder.onerror = (e) => {
                        log('褰曞儚鍑洪敊: ' + (e.error ? e.error.name : 'unknown'), 'error');
                        session.aborted = true;
                        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (err) { /* 蹇界暐 */ }
                        resolve(null);
                    };

                    // 鍒拌揪鏈€闀挎椂闀胯嚜鍔ㄥ仠姝紙鏈嶅姟绔悓鏃舵湁鐪嬮棬鐙楋級
                    session.timer = setTimeout(() => {
                        if (this.videoRecording === session && recorder.state === 'recording') {
                            log('褰曞儚杈惧埌鏈€闀挎椂闀匡紝鑷姩鍋滄', 'info');
                            recorder.stop();
                        }
                    }, maxDurationMs);

                    // 鏈€闀挎椂闀跨粨鏉熷悗鍐嶇暀2绉掔粰stop_record鍛戒护锛岄槻姝㈠畾鏃跺櫒鍏堝埌
                    recorder.start(500); // 500ms鍒嗙墖鏀堕泦
                    this._showRecordingBadge();
                    log('寮€濮嬪綍鍍? request_id=' + requestId + ', 鏈€闀? + maxDurationMs + 'ms', 'info');

                    // 閫氱煡websocket灞傚彂閫乺ecord_started鍥炴墽
                    window.dispatchEvent(new CustomEvent('video-recording-started', { detail: { requestId } }));
                });
            };

            /**
             * 鎻愬墠鍋滄褰撳墠褰曞儚锛堟湇鍔＄stop_record瑙﹀彂锛夛紝褰曞儚缁撴灉鐢眗ecordVideo鐨凱romise浜や粯
             */
            window.stopVideoRecording = () => {
                const session = this.videoRecording;
                if (session && session.recorder && session.recorder.state === 'recording') {
                    log('鏀跺埌鍋滄褰曞儚鎸囦护', 'info');
                    try { clearTimeout(session.timer); } catch (e) { /* 蹇界暐 */ }
                    session.recorder.stop();
                }
            };

            /**
             * 涓婁紶褰曞儚鍒版湇鍔＄瑙嗛鎺ュ彛锛堢洿鍏ュぇ妯″瀷涓婁笅鏂囷級
             * @param {Blob} blob 褰曞儚鏁版嵁
             * @param {string} requestId 褰曞儚浼氳瘽ID
             */
            window.uploadVideoBlob = async (blob, requestId) => {
                if (!blob || !requestId) {
                    return { success: false, error: '缂哄皯褰曞儚鏁版嵁鎴栦細璇滻D' };
                }
                try {
                    const xz_tester_vision = localStorage.getItem('xz_tester_vision');
                    if (!xz_tester_vision) {
                        log('鏈厤缃瑙夋湇鍔★紝鏃犳硶涓婁紶褰曞儚', 'warning');
                        return { success: false, error: '鏈厤缃瑙夋湇鍔? };
                    }
                    const visionInfo = JSON.parse(xz_tester_vision);
                    // 浼樺厛浣跨敤鏈嶅姟绔笅鍙戠殑video_url锛屾棫閰嶇疆鍥為€€涓轰粠url鎺ㄥ
                    const videoUrl = visionInfo.video_url ||
                        (visionInfo.url ? visionInfo.url.replace('/mcp/vision/explain', '/mcp/vision/video') : '');
                    if (!videoUrl || !visionInfo.token) {
                        throw new Error('瑙嗚閰嶇疆缂哄皯瑙嗛鎺ュ彛鍦板潃(video_url)鎴栦护鐗?token)');
                    }

                    const deviceId = document.getElementById('deviceMac')?.value || '';
                    const clientId = document.getElementById('clientId')?.value || 'web_test_client';

                    const formData = new FormData();
                    formData.append('request_id', requestId);
                    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
                    formData.append('video', blob, 'record.' + ext);

                    log('姝ｅ湪涓婁紶褰曞儚: ' + videoUrl, 'info');
                    const response = await fetch(videoUrl, {
                        method: 'POST',
                        body: formData,
                        headers: {
                            'Device-Id': deviceId,
                            'Client-Id': clientId,
                            'Authorization': 'Bearer ' + visionInfo.token
                        }
                    });

                    const result = await response.json().catch(() => ({}));
                    if (!response.ok) {
                        throw new Error('HTTP ' + response.status + (result.message ? ': ' + result.message : ''));
                    }
                    log('褰曞儚涓婁紶鎴愬姛', 'success');
                    return { success: true, result };
                } catch (error) {
                    log('褰曞儚涓婁紶澶辫触: ' + error.message, 'error');
                    return { success: false, error: error.message };
                }
            };

            window.switchCamera = async() => {
                if (window.switchCameraTimer) return;
                if (this.cameraStream) {
                    const currentTransform = window.getComputedStyle(cameraContainer).transform;
                    const originalTransform = currentTransform === 'none' ? 'translate(0px, 0px)' : currentTransform;
                    cameraContainer.style.setProperty('--original-transform', originalTransform);
                    cameraContainer.classList.add('flip');
                    if (cameraSwitchMask) cameraSwitchMask.style.opacity = 0; 
                    this.currentFacingMode = this.currentFacingMode === 'user' ? 'environment' : 'user';
                    window.stopCamera();
                    window.startCamera();
                    
                    window.switchCameraTimer = setTimeout(() => {
                        if (this.currentFacingMode === 'user') {
                            cameraVideo.style.transform = 'scaleX(-1)';
                        } else {
                            cameraVideo.style.transform = 'scaleX(1)';
                        }
                        window.switchCameraTimer = null;
                        cameraContainer.classList.remove('flip');
                        cameraContainer.style.removeProperty('--original-transform');
                        if (cameraSwitchMask) cameraSwitchMask.style.opacity = 1; 
                    }, 500);
                }
            };

            window.takePhoto = (question = '鎻忚堪涓€涓嬬湅鍒扮殑鐗╁搧') => {
                return new Promise(async (resolve) => {
                    const canvas = document.createElement('canvas');
                    const video = cameraVideo;

                    if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) {
                        log('鏃犳硶鎷嶇収锛氭憚鍍忓ご鏈氨缁?, 'warning');
                        resolve({
                            success: false,
                            error: '鎽勫儚澶存湭灏辩华锛岃纭繚宸茶繛鎺ヤ笖鎽勫儚澶村凡鍚姩'
                        });
                        return;
                    }

                    canvas.width = video.videoWidth || 180;
                    canvas.height = video.videoHeight || 240;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

                    const photoData = canvas.toDataURL('image/jpeg', 0.8);
                    log(`鎷嶇収鎴愬姛锛屽浘鍍忔暟鎹暱搴? ${photoData.length}`, 'success');

                    try {
                        const xz_tester_vision = localStorage.getItem('xz_tester_vision');
                        if (xz_tester_vision) {
                            let visionInfo = null;

                            try {
                                visionInfo = JSON.parse(xz_tester_vision);
                            } catch (err) {
                                throw new Error(`瑙嗚閰嶇疆瑙ｆ瀽澶辫触`);
                            }

                            const { url, token } = visionInfo || {};
                            if (!url || !token) {
                                throw new Error('瑙嗚鍒嗘瀽澶辫触锛氶厤缃己灏戞帴鍙ｅ湴鍧€(url)鎴栦护鐗?token)');
                            }

                            log(`姝ｅ湪鍙戦€佸浘鐗囧埌瑙嗚鍒嗘瀽鎺ュ彛: ${url}`, 'info');

                            const deviceId = document.getElementById('deviceMac')?.value || '';
                            const clientId = document.getElementById('clientId')?.value || 'web_test_client';

                            const formData = new FormData();
                            formData.append('question', question);
                            formData.append('image', dataURItoBlob(photoData), 'photo.jpg');

                            const response = await fetch(url, {
                                method: 'POST',
                                body: formData,
                                headers: {
                                    'Device-Id': deviceId,
                                    'Client-Id': clientId,
                                    'Authorization': `Bearer ${token}`
                                }
                            });

                            if (!response.ok) {
                                throw new Error(`HTTP error! status: ${response.status}`);
                            }

                            const analysisResult = await response.json();
                            log(`瑙嗚鍒嗘瀽瀹屾垚: ${JSON.stringify(analysisResult).substring(0, 200)}...`, 'success');

                            resolve({
                                success: true,
                                message: question,
                                photo_data: photoData,
                                photo_width: canvas.width,
                                photo_height: canvas.height,
                                vision_analysis: analysisResult
                            });
                        } else {
                            log('鏈厤缃瑙夊垎鏋愭湇鍔?, 'warning');
                        }
                    } catch (error) {
                        log(`瑙嗚鍒嗘瀽澶辫触: ${error.message}`, 'error');
                        resolve({
                            success: true,
                            message: question,
                            photo_data: photoData,
                            photo_width: canvas.width,
                            photo_height: canvas.height,
                            vision_analysis: {
                                success: false,
                                error: error.message,
                                fallback: '鏃犳硶杩炴帴鍒拌瑙夊垎鏋愭湇鍔?
                            }
                        });
                    }
                });
            };

            log('鎽勫儚澶村垵濮嬪寲瀹屾垚', 'success');
            resolve(true);
        });
    }
}

// 鍒涘缓骞跺惎鍔ㄥ簲鐢?
const app = new App();
// 灏嗗簲鐢ㄥ疄渚嬫毚闇插埌鍏ㄥ眬锛屼緵鍏朵粬妯″潡璁块棶
window.chatApp = app;
document.addEventListener('DOMContentLoaded', () => {
    // 鍒濆鍖栧簲鐢?
    app.init();
});
export default app;
