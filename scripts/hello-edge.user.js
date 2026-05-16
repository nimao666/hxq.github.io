// ==UserScript==
// @name        海角社区 m3u8 提取 + 去广告 + 付费解锁 终极版
// @namespace   haijiao-analyst
// @version     5.0.0
// @author      binghe 修改版 + 标准答案 v3 合并优化
// @description (手机版) 1.自动屏蔽广告 2.捕获 m3u8 原位替换播放器 3.HLS 引擎+节点注入兜底 4.付费 5 秒限时解锁 5.VIP 伪装 6.付费弹窗静默
// @license     MIT
// @match       *://*.haijiao.com/*
// @match       *://*/post/details*
// @grant       GM_addStyle
// @grant       unsafeWindow
// @run-at      document-start
// ==/UserScript==

(function () {
    'use strict';

    // =====================================================================
    //  常量 & 工具
    // =====================================================================
    const TAG = '[HJ+]';
    const BTN_ID = 'hj-play-btn-mobile';
    const TOAST_ID = 'hj-toast-mobile';
    const PAY_RE = /VIP|会员|成为VIP|前往开通|购买|付费|开通/;

    const log = (...a) => console.log(`%c${TAG}`, 'color:#10b981;font-weight:bold', ...a);
    const warn = (...a) => console.warn(TAG, ...a);

    let capturedM3u8Url = '';
    let hasReplaced = false;

    // =====================================================================
    //  模块一：去广告（静态样式 + 周期性 DOM 清洗）
    // =====================================================================
    GM_addStyle(`
        [class*="guanggao"], [class*="ads"], [id*="ads"],
        [class*="banner-ad"], [id*="banner-ad"],
        .float-box, .float-window, .couplet,
        .top-ad, .bottom-ad, .ad-container, .gg-box,
        .ad-box img, a[href*="bocai"],
        .sell_line1, .sell_line2, .preview-title,
        iframe:not([src*="m3u8"]):not([src*="player"]):not([id*="play"])
        {
            display: none !important;
            visibility: hidden !important;
            height: 0 !important;
            width: 0 !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
        body { overflow-x: hidden; }

        #${BTN_ID} {
            position: fixed;
            bottom: 80px;
            right: 15px;
            width: 55px;
            height: 55px;
            border-radius: 50%;
            background-color: rgba(30, 60, 114, 0.95);
            color: white;
            border: 2px solid rgba(255,255,255,0.3);
            z-index: 999999;
            font-size: 24px;
            text-align: center;
            line-height: 51px;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
            display: none;
            box-shadow: 0 4px 10px rgba(0,0,0,0.4);
            transition: transform 0.2s, background-color 0.3s;
            cursor: pointer;
        }
        #${BTN_ID}.show { display: block; }
        #${BTN_ID}.active { transform: scale(0.9); }
        #${BTN_ID}.played { background-color: rgba(46, 139, 87, 0.95); }

        #${TOAST_ID} {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0,0,0,0.85);
            color: #fff;
            padding: 12px 24px;
            border-radius: 10px;
            z-index: 1000000;
            font-size: 15px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s;
            backdrop-filter: blur(6px);
        }
    `);

    function cleanUpAds() {
        document.querySelectorAll('div[style*="z-index: 999"]').forEach(div => {
            if (div.id === BTN_ID || div.id === TOAST_ID) return;
            div.remove();
        });
        document.querySelectorAll('div[style*="position: fixed"]').forEach(div => {
            if (div.id === BTN_ID || div.id === TOAST_ID) return;
            if (div.querySelector('iframe') || div.querySelector('img')) {
                div.style.display = 'none';
            }
        });
    }
    setInterval(cleanUpAds, 2500);

    // =====================================================================
    //  模块二：付费限时解锁（来自 ctf 标准答案 v3）
    // =====================================================================

    // 2-1. DPlayer.prototype.on —— 吞掉付费限时 timeupdate 回调
    function patchDPlayer(DP) {
        const proto = DP && DP.prototype;
        if (!proto || !proto.on || proto.on.__hj) return;
        const _on = proto.on;
        const wrapped = function (evt, fn) {
            try {
                const src = (fn && fn.toString && fn.toString()) || '';
                // 付费 timeupdate 回调的特征：showPayBox / payStyle / getPlayStatus / seek(0) / ischeckData
                if (evt === 'timeupdate' &&
                    /showPayBox|payStyle|getPlayStatus|ischeckData|\.seek\(0\)/.test(src)) {
                    log('🚫 block paywall timeupdate');
                    return this;
                }
                // 付费 / 加载失败的 error 弹窗也顺手静默
                if (evt === 'error' && /视频加载失败|dialog\.confirm/.test(src)) {
                    return _on.call(this, evt, () => log('🚫 silent error handler'));
                }
            } catch (_) {}
            return _on.call(this, evt, fn);
        };
        wrapped.__hj = true;
        proto.on = wrapped;
        log('DPlayer.prototype.on patched');
    }

    // 守住 window.DPlayer 赋值（chunk 懒加载）
    (function watchDPlayer() {
        let _dp = unsafeWindow.DPlayer;
        if (_dp) patchDPlayer(_dp);
        try {
            Object.defineProperty(unsafeWindow, 'DPlayer', {
                configurable: true,
                get() { return _dp; },
                set(v) { _dp = v; if (v) patchDPlayer(v); },
            });
        } catch (_) {
            // defineProperty 失败则退回轮询
            setInterval(() => { if (unsafeWindow.DPlayer) patchDPlayer(unsafeWindow.DPlayer); }, 2000);
        }
    })();

    // 2-2. vant $dialog —— 静默付费 / VIP 文案
    function wrapDialog(d) {
        if (!d || d.__hj) return d;
        ['confirm', 'alert'].forEach(m => {
            const orig = d[m];
            if (!orig) return;
            d[m] = function (opts) {
                const msg = (opts && (opts.message || opts.title)) || '';
                if (PAY_RE.test(msg)) {
                    log('🚫 $dialog.' + m + ':', String(msg).slice(0, 40));
                    return Promise.resolve();
                }
                return orig.apply(this, arguments);
            };
        });
        d.__hj = true;
        return d;
    }

    // Vue 2 的 $dialog 挂在 Vue.prototype 上，等 Vue 出现后再打补丁
    (function watchVue() {
        let _Vue = unsafeWindow.Vue;
        try {
            Object.defineProperty(unsafeWindow, 'Vue', {
                configurable: true,
                get() { return _Vue; },
                set(v) {
                    _Vue = v;
                    try {
                        if (v && v.prototype) {
                            wrapDialog(v.prototype.$dialog);
                            let _d = v.prototype.$dialog;
                            Object.defineProperty(v.prototype, '$dialog', {
                                configurable: true,
                                get() { return _d; },
                                set(x) { _d = wrapDialog(x); },
                            });
                        }
                    } catch (e) { warn('Vue patch', e); }
                },
            });
        } catch (_) {}
    })();

    // 2-3. Vuex —— 强制 VIP 通行
    function forceVip() {
        try {
            const root = document.querySelector('#app');
            const vm = root && (root.__vue__ || root.__vueParentComponent);
            const store = vm && vm.$store;
            if (!store) return false;
            if (store.state && store.state.userInfo && store.state.userInfo.vip !== 1) {
                store.state.userInfo.vip = 1;
                log('forced $store.state.userInfo.vip = 1');
            }
            return true;
        } catch (_) { return false; }
    }
    const vipTimer = setInterval(() => { if (forceVip()) clearInterval(vipTimer); }, 1000);

    // =====================================================================
    //  模块三：M3U8 数据拦截（XHR hook）
    // =====================================================================

    // 从 m3u8 文本推断真实 m3u8 地址
    function getRealVideoSrc(content, requestUrl) {
        if (!content) return '';
        try {
            // 优先：整段里直接出现完整 m3u8 URL
            const directMatch = String(content).match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/);
            if (directMatch) return directMatch[0];

            if (content.includes('#EXTM3U')) {
                // master playlist：直接复用请求 URL
                if (/#EXT-X-STREAM-INF/.test(content)) return requestUrl;
                // 从 ts 文件名推断索引名
                const baseUrl = requestUrl.substring(0, requestUrl.lastIndexOf('/') + 1);
                const m = content.match(/([\w_]+_?)[\d]+\.ts/);
                if (m) return baseUrl + m[1] + '.m3u8';
                return requestUrl;
            }

            // 非标准格式：逐行找 ts
            const tsLine = content.split('\n').find(line => line.includes('.ts'));
            if (tsLine) {
                const reg = tsLine.match(/([\w_]+_?)[\d]+\.ts/);
                if (reg) return tsLine.replace(reg[0], reg[1] + '.m3u8').trim();
            }
        } catch (_) {}
        return '';
    }

    // 三层 base64 解码
    function decodeEncryptString(text) {
        if (typeof text !== 'string') return text;
        try {
            const obj = JSON.parse(text);
            if (obj && typeof obj.data === 'object') return obj.data;
            if (obj && typeof obj.data === 'string') {
                try { return JSON.parse(atob(atob(atob(obj.data)))); } catch (_) {}
            }
            return obj;
        } catch (_) { return null; }
    }

    // XHR 拦截（保留原 prototype、防重复包装）
    (function hookXHR() {
        const OrigXHR = unsafeWindow.XMLHttpRequest;
        if (!OrigXHR || OrigXHR.__hj) return;

        const Wrapped = function () {
            const xhr = new OrigXHR();
            const _open = xhr.open;
            const _send = xhr.send;
            let reqUrl = '';

            xhr.open = function (_method, url) {
                reqUrl = url || '';
                return _open.apply(this, arguments);
            };

            xhr.send = function () {
                if (reqUrl.includes('/api/address/') || reqUrl.includes('/api/topic/')) {
                    xhr.addEventListener('load', function () {
                        setTimeout(() => handleResponse(xhr, reqUrl), 0);
                    });
                }
                return _send.apply(this, arguments);
            };

            return xhr;
        };
        Wrapped.__hj = true;
        Wrapped.prototype = OrigXHR.prototype;
        unsafeWindow.XMLHttpRequest = Wrapped;
    })();

    async function handleResponse(xhr, url) {
        try {
            if (url.includes('/api/address/')) {
                const src = getRealVideoSrc(xhr.responseText, url);
                if (src) updateState(src);
                return;
            }
            if (/\/api\/topic\/\d+/.test(url)) {
                const data = decodeEncryptString(xhr.responseText);
                const atts = data?.attachments || [];
                for (const item of atts) {
                    if (item.category !== 'video' || !item.remoteUrl) continue;
                    try {
                        const resp = await fetch(item.remoteUrl);
                        const content = await resp.text();
                        const src = getRealVideoSrc(content, item.remoteUrl);
                        if (src) updateState(src);
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }

    function updateState(src) {
        if (!src || src === capturedM3u8Url) return;
        capturedM3u8Url = src;
        log('captured m3u8:', src);
        showToast('已捕获完整 M3U8 索引，正在自动替换播放器...');
        if (!hasReplaced) replaceAndPlayVideo();
    }

    // =====================================================================
    //  模块四：播放器替换（原位注入）
    // =====================================================================
    function replaceAndPlayVideo() {
        if (hasReplaced) return;
        hasReplaced = true;
        showToast('开始启动数据管线与播放器构筑...');

        // 【1】清理旧视频：暂停并清空播放器外壳
        document.querySelectorAll('video').forEach(v => {
            v.pause();
            v.removeAttribute('src');
            v.load();
            const shell = v.closest('.video-div') || v.closest('.dplayer') || v.parentElement;
            if (shell) shell.innerHTML = '';
        });

        // 隐藏付费提示文案
        document.querySelectorAll('.sell_line1, .sell_line2, .preview-title').forEach(el => {
            el.style.display = 'none';
        });

        // 【2】寻找注入容器
        const candidates = document.querySelectorAll(
            '.video-div, .dplayer, [id^="video_"], .sell-btn, .post-details'
        );
        let targetContainer;
        if (candidates.length > 0) {
            targetContainer = candidates[0];
            log('常规寻址成功');
        } else {
            // 兜底：凭空造一个 div 插到内容顶部
            log('常规寻址脱靶，触发降级注入');
            showToast('启用兜底注入模式，强制渲染播放器');
            targetContainer = document.createElement('div');
            targetContainer.style.margin = '15px 0';
            const contentArea = document.querySelector('.post-content')
                || document.querySelector('.article-content')
                || document.body;
            contentArea.insertBefore(targetContainer, contentArea.firstChild);
        }
        targetContainer.innerHTML = '';

        // 【3】提取页面标题
        const pageTitle = (document.querySelector('.header h2 > span')?.textContent
            || document.title || '播放中').trim();
        log('页面标题:', pageTitle);

        // 【4】构建播放器 UI
        const playerId = 'clean-core-player-' + Date.now();
        targetContainer.innerHTML = `
            <div style="margin: 0 auto; width: 100%; border-radius: 12px; overflow: hidden; box-shadow: 0 12px 32px rgba(0,0,0,0.9); background-color: #000; border: 1px solid #2a2a2a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                <div style="margin: 0; padding: 14px 18px; background: #18181c; border-bottom: 1px solid #0d0d0f; display: flex; flex-direction: column; gap: 8px;">
                    <div style="font-size: 16px; font-weight: 600; color: #ececec; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.3px;">
                        ${pageTitle}
                    </div>
                    <div style="font-size: 12px; color: #10b981; display: flex; align-items: center; font-weight: 500;">
                        <span style="display:inline-block; width: 6px; height: 6px; background-color: #10b981; border-radius: 50%; margin-right: 8px; box-shadow: 0 0 8px rgba(16,185,129,0.8);"></span>
                        <span style="opacity: 0.9;">Analytics 探针激活 · 广告及播放限制已彻底解除 · M3U8 直连就绪</span>
                    </div>
                </div>
                <video
                    id="${playerId}"
                    controls
                    playsinline
                    webkit-playsinline
                    style="display: block; width: 100%; max-height: 80vh; background-color: #000; margin: 0; padding: 0; border: none; outline: none;">
                </video>
            </div>
        `;

        const videoEl = document.getElementById(playerId);
        if (!videoEl) { warn('video element not found'); return; }

        // 【5】HLS 挂载
        attachHls(videoEl, capturedM3u8Url);

        const btn = document.getElementById(BTN_ID);
        if (btn) {
            btn.classList.add('played');
            btn.textContent = '✔️';
        }
    }

    function attachHls(videoEl, url) {
        // 场景 1：iOS 原生 HLS
        if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            videoEl.src = url;
            showToast('iOS 原生硬解就绪，点击播放');
            return;
        }

        // 场景 2：hls.js 软解
        const HlsLib = unsafeWindow.Hls || window.Hls;
        if (HlsLib && HlsLib.isSupported()) {
            mountHls(HlsLib, videoEl, url);
            showToast('HLS 引擎解码就绪，点击播放');
            return;
        }

        // 场景 3：动态加载 hls.js（固定版本，避免 latest 漂移）
        showToast('主动下载边缘节点 M3U8 解析器...');
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
        script.onload = () => {
            const Hls2 = unsafeWindow.Hls || window.Hls;
            if (Hls2 && Hls2.isSupported()) {
                mountHls(Hls2, videoEl, url);
                showToast('外置引擎挂载完毕，点击播放');
            } else {
                showToast('您的设备底层解码器版本不兼容。');
            }
        };
        script.onerror = () => showToast('HLS 引擎加载失败，请检查网络');
        document.head.appendChild(script);
    }

    function mountHls(HlsLib, videoEl, url) {
        const hls = new HlsLib({ maxBufferLength: 30, enableWorker: true });
        hls.loadSource(url);
        hls.attachMedia(videoEl);
        hls.on(HlsLib.Events.MANIFEST_PARSED, () => log('HLS manifest parsed'));
        hls.on(HlsLib.Events.ERROR, (_evt, data) => {
            if (!data || !data.fatal) return;
            warn('HLS fatal:', data.type, data.details);
            if (data.type === HlsLib.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        });
    }

    // =====================================================================
    //  Toast
    // =====================================================================
    function showToast(msg, ms = 3000) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.style.opacity = '0'; }, ms);
    }

    // =====================================================================
    //  初始化 & SPA 路由兜底
    // =====================================================================
    function init() {
        if (document.getElementById(BTN_ID)) return;
        const btn = document.createElement('div');
        btn.id = BTN_ID;
        btn.textContent = '▶️';
        btn.onclick = () => {
            btn.classList.add('active');
            setTimeout(() => btn.classList.remove('active'), 100);
            if (capturedM3u8Url) {
                hasReplaced = false;
                replaceAndPlayVideo();
            } else {
                showToast('后台尚未捕获到完整数据的索引参数，请等待刷新或播放原视频探寻。');
            }
        };
        document.body.appendChild(btn);
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function onRouteChange() {
        capturedM3u8Url = '';
        hasReplaced = false;
        const btn = document.getElementById(BTN_ID);
        if (btn) {
            btn.classList.remove('show', 'played');
            btn.textContent = '▶️';
        }
        forceVip();
        if (unsafeWindow.DPlayer) patchDPlayer(unsafeWindow.DPlayer);
        setTimeout(cleanUpAds, 500);
    }

    ['pushState', 'replaceState'].forEach(m => {
        const orig = history[m];
        history[m] = function () {
            const r = orig.apply(this, arguments);
            setTimeout(onRouteChange, 300);
            return r;
        };
    });
    window.addEventListener('popstate', () => setTimeout(onRouteChange, 300));

    log('loaded v5.0');
})();
