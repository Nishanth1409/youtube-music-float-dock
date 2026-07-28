/**
 * YouTube Music Float Dock — floating control dock (window, PiP, random).
 */
(function () {
  'use strict';

  /** Stop legacy radio/shuffle loops from older extension versions in this tab. */
  function cleanupLegacyRadioAndShuffle() {
    const legacyKeys = [
      'ytm-style-radio-active',
      'ytm-style-radio-artist',
      'ytm-style-radio-seed',
      'ytm-style-radio-rotation',
      'ytm-auto-random-played',
      'ytm-random-session-picks',
      'ytm-shuffle-default-done'
    ];
    legacyKeys.forEach((key) => {
      try {
        sessionStorage.removeItem(key);
      } catch (_) {
        /* ignore */
      }
    });

    document.querySelectorAll('.ytm-dock-random').forEach((el) => el.remove());

    if (window.YtmStyleRadio?.ensureRadioContinues) {
      window.YtmStyleRadio.ensureRadioContinues = () => {};
    }
  }

  cleanupLegacyRadioAndShuffle();

  const SETTINGS = {
    floatEnabled: 'floatRandomEnabled',
    dockTopPercent: 'floatDockTopPercent'
  };

  const DEFAULT_TOP_PERCENT = 15;
  const MIN_TOP_PERCENT = 3;
  const MAX_TOP_PERCENT = 92;

  const SESSION_WINDOW_FS_KEY = 'ytm-auto-window-fs-done';
  const AUTO_WINDOW_FS_KEY = 'autoWindowFullscreenOnOpen';
  const LOG_PREFIX = '[YTM Float]';
  const DOCK_ID = 'ytm-float-dock';

  let dock = null;
  let displayMenu = null;
  let displayMenuOutsideHandler = null;
  let isVerticalDragging = false;
  let dragMoved = false;
  let dragStartY = 0;
  let dragStartPercent = DEFAULT_TOP_PERCENT;

  let config = {
    floatEnabled: true,
    dockTopPercent: DEFAULT_TOP_PERCENT
  };

  let randomPlayBusy = false;

  const ext = () => window.YtmExtension;

  function log(...args) {
    console.debug(LOG_PREFIX, ...args);
  }

  function logWarn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function clampTopPercent(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return DEFAULT_TOP_PERCENT;
    return Math.min(MAX_TOP_PERCENT, Math.max(MIN_TOP_PERCENT, Math.round(n)));
  }

  function loadSettings(callback) {
    if (!ext()?.isContextValid()) {
      callback();
      return;
    }
    ext().storageGet([SETTINGS.floatEnabled, SETTINGS.dockTopPercent], (result) => {
        config.floatEnabled = result[SETTINGS.floatEnabled] !== false;
        config.dockTopPercent = clampTopPercent(
          result[SETTINGS.dockTopPercent] ?? DEFAULT_TOP_PERCENT
        );
        callback();
      }
    );
  }

  function saveDockTopPercent(percent) {
    config.dockTopPercent = clampTopPercent(percent);
    if (!ext()?.isContextValid()) return;
    ext().storageSet({ [SETTINGS.dockTopPercent]: config.dockTopPercent });
  }

  function applyDockPosition() {
    if (!dock) return;
    dock.style.top = `${config.dockTopPercent}%`;
    dock.style.right = '8px';
    dock.style.left = 'auto';
    dock.style.bottom = 'auto';
  }

  function isPlayerActive() {
    const video = document.querySelector('video');
    if (video && !video.paused && video.currentTime > 1) return true;

    const player = document.getElementById('movie_player');
    if (player && typeof player.getPlayerState === 'function') {
      try {
        return player.getPlayerState() === 1;
      } catch (_) {
        return false;
      }
    }

    return false;
  }

  function setRandomStatus(text, busy) {
    if (!dock) return;
    const randomBtn = dock.querySelector('.ytm-dock-random');
    randomBtn?.classList.toggle('ytm-dock-busy', Boolean(busy));
    randomBtn?.setAttribute('title', busy ? text : 'Random from your listens');
  }

  function setPipStatus(text, busy) {
    if (!dock) return;
    const pipBtn = dock.querySelector('.ytm-dock-pip');
    pipBtn?.classList.toggle('ytm-dock-busy', Boolean(busy));
    pipBtn?.classList.toggle('ytm-dock-pip-active', Boolean(
      document.pictureInPictureElement || window.documentPictureInPicture?.window
    ));
    pipBtn?.setAttribute('title', busy ? text : 'Picture-in-Picture + minimize');
  }

  const PIP_CANVAS_VIDEO_ID = 'ytm-pip-canvas-video';
  const PIP_ART_CANVAS_ID = 'ytm-pip-art-canvas';
  const DOC_PIP_ART_ID = 'ytm-doc-pip-art';
  const PIP_MAX_EDGE = 640;
  const PIP_MIN_EDGE = 160;

  function pipCanvasSizeFromMetrics(metrics) {
    let width = metrics?.width || PIP_MAX_EDGE;
    let height = metrics?.height || PIP_MAX_EDGE;
    const maxEdge = Math.max(width, height);
    if (maxEdge > PIP_MAX_EDGE) {
      const scale = PIP_MAX_EDGE / maxEdge;
      width = Math.max(PIP_MIN_EDGE, Math.round(width * scale));
      height = Math.max(PIP_MIN_EDGE, Math.round(height * scale));
    }
    return { width, height };
  }

  function pipSizeFromRatio(ratio) {
    if (!ratio || !Number.isFinite(ratio) || ratio <= 0) ratio = 1;

    let width;
    let height;
    if (ratio >= 1) {
      width = PIP_MAX_EDGE;
      height = Math.max(PIP_MIN_EDGE, Math.round(PIP_MAX_EDGE / ratio));
    } else {
      height = PIP_MAX_EDGE;
      width = Math.max(PIP_MIN_EDGE, Math.round(PIP_MAX_EDGE * ratio));
    }

    return { width, height, ratio: width / height };
  }

  async function resolvePipContentMetrics(video, artUrl) {
    if (video && videoHasPicture(video)) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w > 0 && h > 0) {
        return { width: w, height: h, ratio: w / h };
      }
    }

    if (artUrl) {
      try {
        const img = await loadImage(artUrl);
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          return {
            width: img.naturalWidth,
            height: img.naturalHeight,
            ratio: img.naturalWidth / img.naturalHeight
          };
        }
      } catch (_) {
        /* try defaults */
      }
    }

    return { width: 1, height: 1, ratio: 1 };
  }

  function bindPipWindowAspectRatioFromOpener(targetWindow, ratio) {
    if (!targetWindow || targetWindow.__ytmPipOpenerBound) return;
    targetWindow.__ytmPipOpenerBound = true;

    let lastW = targetWindow.innerWidth || 0;
    let lastH = targetWindow.innerHeight || 0;
    let adjusting = false;
    let resizeAxis = null;
    let settleTimer = null;

    const snapToRatio = () => {
      if (adjusting) return;

      const w = targetWindow.innerWidth;
      const h = targetWindow.innerHeight;
      if (!w || !h) return;

      const dw = w - lastW;
      const dh = h - lastH;
      if (Math.abs(dw) < 1 && Math.abs(dh) < 1) return;

      if (!resizeAxis) {
        resizeAxis = Math.abs(dw) >= Math.abs(dh) ? 'w' : 'h';
      }

      let newW = w;
      let newH = h;
      if (resizeAxis === 'w') {
        newH = Math.max(PIP_MIN_EDGE, Math.round(w / ratio));
      } else {
        newW = Math.max(PIP_MIN_EDGE, Math.round(h * ratio));
      }

      if (newW !== w || newH !== h) {
        try {
          adjusting = true;
          targetWindow.resizeTo(newW, newH);
          lastW = newW;
          lastH = newH;
        } catch (_) {
          lastW = w;
          lastH = h;
        } finally {
          adjusting = false;
        }
      } else {
        lastW = w;
        lastH = h;
      }

      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        resizeAxis = null;
      }, 50);
    };

    targetWindow.addEventListener('resize', snapToRatio);

    requestAnimationFrame(() => {
      lastW = targetWindow.innerWidth;
      lastH = targetWindow.innerHeight;
      snapToRatio();
    });
  }

  function bindPipWindowAspectRatio(targetWindow, ratio) {
    if (!targetWindow || !ratio || !Number.isFinite(ratio) || ratio <= 0) return;

    targetWindow.__ytmPipRatio = ratio;

    const doc = targetWindow.document;
    if (!doc) return;

    doc.documentElement.dataset.ytmPipRatio = String(ratio);
    doc.documentElement.dataset.ytmPipMinEdge = String(PIP_MIN_EDGE);

    if (!chrome?.runtime?.getURL) {
      bindPipWindowAspectRatioFromOpener(targetWindow, ratio);
      return;
    }

    if (doc.querySelector('script[data-ytm-pip-aspect]')) return;

    const script = doc.createElement('script');
    script.src = chrome.runtime.getURL('pip-aspect-ratio.js');
    script.dataset.ytmPipAspect = '1';
    script.addEventListener('error', () => {
      bindPipWindowAspectRatioFromOpener(targetWindow, ratio);
    });
    (doc.head || doc.documentElement).appendChild(script);
  }

  function bindVideoPipAspectRatio(_video) {
    /* Native video PiP windows keep the media aspect ratio when resized. */
  }

  function getMainPlaybackVideo() {
    const candidates = [
      document.querySelector('video.html5-main-video'),
      document.querySelector('#movie_player video'),
      ...document.querySelectorAll('video')
    ].filter(Boolean);

    for (const video of candidates) {
      if (video.id === PIP_CANVAS_VIDEO_ID) continue;
      return video;
    }
    return null;
  }

  function getPlaybackVideo() {
    return getMainPlaybackVideo();
  }

  function clickPlayerBarPlayPause() {
    const barBtn = document.querySelector(
      'ytmusic-player-bar .play-pause-button, ytmusic-player-bar #play-pause-button, .ytp-play-button'
    );
    if (barBtn) {
      barBtn.click();
      return true;
    }
    return false;
  }

  function syncWindowsMediaSession() {
    if (!navigator.mediaSession) return;

    const meta = getNowPlayingMeta();
    const artUrl = getAlbumArtUrl();
    const video = getMainPlaybackVideo();
    const artwork = [];

    if (artUrl) {
      artwork.push({ src: artUrl, sizes: '96x96', type: 'image/jpeg' });
      artwork.push({ src: artUrl, sizes: '256x256', type: 'image/jpeg' });
      artwork.push({ src: artUrl, sizes: '512x512', type: 'image/jpeg' });
    }

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title || 'YouTube Music',
        artist: meta.artist || '',
        album: 'YouTube Music',
        artwork
      });
    } catch (_) {
      /* ignore metadata errors */
    }

    if (video) {
      navigator.mediaSession.playbackState = video.paused ? 'paused' : 'playing';
    }
  }

  function requestTabFocusForMedia() {
    if (!ext()?.isContextValid()) return;
    ext().sendMessage({ type: 'FOCUS_YTM_TAB' });
  }

  let mediaSessionSyncVideo = null;
  let mediaSessionSyncHandlers = null;
  let mediaSessionSyncIntervalId = null;
  let pipMediaBridgeCleanup = null;

  function detachMediaSessionSync() {
    if (mediaSessionSyncVideo && mediaSessionSyncHandlers) {
      const { onPlay, onPause, onLoaded } = mediaSessionSyncHandlers;
      mediaSessionSyncVideo.removeEventListener('play', onPlay);
      mediaSessionSyncVideo.removeEventListener('pause', onPause);
      mediaSessionSyncVideo.removeEventListener('loadedmetadata', onLoaded);
      mediaSessionSyncVideo.removeEventListener('ratechange', onLoaded);
    }
    mediaSessionSyncVideo = null;
    mediaSessionSyncHandlers = null;
  }

  function attachMediaSessionSync() {
    detachMediaSessionSync();
    const video = getMainPlaybackVideo();
    if (!video || !navigator.mediaSession) return;

    const onPlay = () => syncWindowsMediaSession();
    const onPause = () => syncWindowsMediaSession();
    const onLoaded = () => syncWindowsMediaSession();

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('ratechange', onLoaded);

    mediaSessionSyncVideo = video;
    mediaSessionSyncHandlers = { onPlay, onPause, onLoaded };
    syncWindowsMediaSession();
  }

  function startMediaSessionPolling() {
    if (mediaSessionSyncIntervalId) return;
    mediaSessionSyncIntervalId = setInterval(() => {
      // YTM sometimes swaps the <video> element without a clean event chain.
      // Re-attach + sync keeps Windows+A + mouse media keys reliable.
      attachMediaSessionSync();
      syncWindowsMediaSession();
    }, 2500);
  }

  function stopMediaSessionPolling() {
    if (!mediaSessionSyncIntervalId) return;
    clearInterval(mediaSessionSyncIntervalId);
    mediaSessionSyncIntervalId = null;
  }

  function restoreWindowsMediaControls(options = {}) {
    // Focusing the main Chrome window while PiP is active un-minimizes it on song change.
    // Only focus when the user intentionally leaves PiP (Back to tab).
    if (options.focusTab !== false) {
      requestTabFocusForMedia();
    }
    attachMediaSessionSync();
    syncWindowsMediaSession();
    setTimeout(syncWindowsMediaSession, 300);
    setTimeout(syncWindowsMediaSession, 1000);
  }

  function detachCanvasPipSync() {
    pipMediaBridgeCleanup?.();
    pipMediaBridgeCleanup = null;
  }

  function stopPipMediaBridge(options = {}) {
    detachCanvasPipSync();
    restoreWindowsMediaControls(options);
  }

  let pipIntentionalSwitch = false;

  function beginPipIntentionalSwitch() {
    pipIntentionalSwitch = true;
  }

  function endPipIntentionalSwitch() {
    // Keep set briefly so leavepictureinpicture handlers don't treat switch as exit.
    setTimeout(() => {
      pipIntentionalSwitch = false;
    }, 1500);
  }

  function startPipMediaBridge(proxyVideo) {
    detachCanvasPipSync();
    syncWindowsMediaSession();

    const isCanvasProxy = Boolean(proxyVideo && proxyVideo.id === PIP_CANVAS_VIDEO_ID);
    if (!isCanvasProxy) return;

    const main = getMainPlaybackVideo();

    const onProxyPlay = () => {
      const video = getMainPlaybackVideo();
      if (video?.paused) {
        clickPlayerBarPlayPause() || video.play().catch(() => {});
      }
      proxyVideo.play().catch(() => {});
    };

    const onProxyPause = () => {
      const video = getMainPlaybackVideo();
      if (video && !video.paused) {
        clickPlayerBarPlayPause() || video.pause();
      }
    };

    const onMainPlay = () => {
      if (!proxyVideo.paused) return;
      proxyVideo.play().catch(() => {});
    };

    const onMainPause = () => {
      if (proxyVideo.paused) return;
      proxyVideo.pause();
    };

    proxyVideo.addEventListener('play', onProxyPlay);
    proxyVideo.addEventListener('pause', onProxyPause);

    if (main) {
      main.addEventListener('play', onMainPlay);
      main.addEventListener('pause', onMainPause);
    }

    pipMediaBridgeCleanup = () => {
      proxyVideo.removeEventListener('play', onProxyPlay);
      proxyVideo.removeEventListener('pause', onProxyPause);
      if (main) {
        main.removeEventListener('play', onMainPlay);
        main.removeEventListener('pause', onMainPause);
      }
    };
  }

  function getAvPlaybackMode() {
    // YTM stores Song/Video on ytmusic-av-toggle: ATV_PREFERRED | OMV_PREFERRED
    const toggle = document.querySelector('ytmusic-av-toggle');
    const toggleMode = (toggle?.getAttribute('playback-mode') || '').toUpperCase();
    if (toggleMode === 'ATV_PREFERRED' || toggleMode.includes('ATV')) return 'song';
    if (toggleMode === 'OMV_PREFERRED' || toggleMode.includes('OMV')) return 'video';

    const page = document.querySelector('ytmusic-player-page');
    const pageMode = (page?.getAttribute('playback-mode') || '').toUpperCase();
    if (pageMode === 'ATV_PREFERRED' || pageMode.includes('ATV')) return 'song';
    if (pageMode === 'OMV_PREFERRED' || pageMode.includes('OMV')) return 'video';
    if (pageMode.includes('SONG') || pageMode === 'AUDIO') return 'song';
    if (pageMode.includes('VIDEO')) return 'video';
    return null;
  }

  function isSongPlaybackMode() {
    const avMode = getAvPlaybackMode();
    if (avMode === 'song') return true;
    if (avMode === 'video') return false;

    const avToggle = document.querySelector('ytmusic-av-toggle');
    if (avToggle) {
      const selected = avToggle.querySelector('[aria-pressed="true"], .selected, [aria-checked="true"]');
      const label = (
        selected?.getAttribute('aria-label') ||
        selected?.textContent ||
        ''
      ).toLowerCase();
      if (label.includes('song') || label.includes('audio')) return true;
      if (label.includes('video')) return false;
    }

    const video = getPlaybackVideo();
    return !videoHasPicture(video);
  }

  function videoHasPicture(video) {
    if (!video) return false;
    if (video.videoWidth > 0 && video.videoHeight > 0) return true;
    if (typeof video.getVideoTracks === 'function') {
      return video.getVideoTracks().length > 0;
    }
    return false;
  }

  /** Official music videos are landscape; ATV song art is usually near-square. */
  function videoLooksLikeMusicVideo(video) {
    if (!videoHasPicture(video)) return false;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return false;
    const ratio = w / h;
    return ratio >= 1.25 || ratio <= 0.8;
  }

  function canUseVideoPip(video) {
    return Boolean(video && videoHasPicture(video) && document.pictureInPictureEnabled);
  }

  function getAlbumArtUrl() {
    const selectors = [
      'ytmusic-player-page img.image',
      'ytmusic-player-page yt-img-shadow img',
      'ytmusic-player-bar img.yt-core-image',
      'ytmusic-player-bar yt-img-shadow img',
      'ytmusic-player-bar #thumbnail img',
      'yt-img-shadow#thumbnail img',
      '#thumbnail img',
      'ytmusic-player-bar img'
    ];

    for (const selector of selectors) {
      const img = document.querySelector(selector);
      const src = img?.src || img?.currentSrc;
      if (src && !src.startsWith('data:') && src.includes('http')) return src;
    }

    const bgTargets = [
      document.querySelector('ytmusic-player-page .image'),
      document.querySelector('ytmusic-player-bar .thumbnail'),
      document.querySelector('ytmusic-player-bar #thumbnail')
    ];

    for (const el of bgTargets) {
      if (!el) continue;
      const bg = getComputedStyle(el).backgroundImage;
      const match = bg && bg.match(/url\(["']?([^"')]+)/);
      if (match?.[1] && !match[1].startsWith('data:')) return match[1];
    }

    return null;
  }

  function getNowPlayingMeta() {
    const title =
      document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() ||
      document.querySelector('ytmusic-player-page .title')?.textContent?.trim() ||
      '';
    const artist =
      document.querySelector('ytmusic-player-bar .byline')?.textContent?.trim() ||
      document.querySelector('ytmusic-player-page .byline')?.textContent?.trim() ||
      '';
    return { title, artist };
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async function trySwitchToVideoMode() {
    const toggle = document.querySelector('ytmusic-av-toggle');
    if (!toggle) return false;

    const buttons = toggle.querySelectorAll('button, tp-yt-paper-button');
    for (const btn of buttons) {
      const label = (
        btn.getAttribute('aria-label') ||
        btn.getAttribute('title') ||
        btn.textContent ||
        ''
      ).toLowerCase();
      if (label.includes('video') && !btn.classList.contains('selected')) {
        btn.click();
        await waitMs(400);
        return videoHasPicture(getPlaybackVideo());
      }
    }

    return false;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        const fallback = new Image();
        fallback.onload = () => resolve(fallback);
        fallback.onerror = reject;
        fallback.src = url;
      };
      img.src = url;
    });
  }

  async function drawAlbumArtOnCanvas(canvas, artUrl, metrics) {
    const size = pipCanvasSizeFromMetrics(metrics || { width: 1, height: 1 });

    // Load first. Setting canvas.width/height clears pixels — never await while blank
    // or PiP shows a black screen via captureStream.
    let img;
    try {
      img = await loadImage(artUrl);
    } catch (_) {
      return false;
    }

    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size.width, size.height);
    return true;
  }

  function tryExpandPlayerSync() {
    const layout = document.querySelector('ytmusic-app-layout');
    if (layout?.getAttribute('player-ui-state') === 'PLAYER_PAGE_OPEN') return;

    const expand =
      document.querySelector('ytmusic-player-bar #expand-button') ||
      document.querySelector('ytmusic-player-bar [aria-label="Expand"]') ||
      document.querySelector('ytmusic-player-bar .thumbnail');

    expand?.click();
  }

  function prepareVideoForPip(video) {
    if (!video) return false;
    video.disablePictureInPicture = false;
    video.removeAttribute('disablepictureinpicture');
    if (video.hasAttribute('controls')) {
      video.setAttribute('controls', 'true');
    }
    return true;
  }

  function waitForPictureInPicture(video, timeoutMs) {
    if (document.pictureInPictureElement === video) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('pip_timeout'));
      }, timeoutMs || 2500);

      function onEnter(event) {
        if (event.target === video) {
          cleanup();
          resolve();
        }
      }

      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('enterpictureinpicture', onEnter);
      }

      video.addEventListener('enterpictureinpicture', onEnter);
    });
  }

  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function minimizeForPip() {
    if (!ext()?.isContextValid()) return;
    ext().sendMessage({ type: 'WINDOW_CONTROL', action: 'minimize', forPip: true }, (response) => {
      if (!response?.ok) logWarn('Minimize for PiP failed:', response?.reason);
    });
  }

  function saveWindowStateBeforePip() {
    return new Promise((resolve) => {
      if (!ext()?.isContextValid()) {
        resolve(null);
        return;
      }
      ext().sendMessage({ type: 'WINDOW_CONTROL', action: 'save-pip-state' }, resolve);
    });
  }

  function waitForVideoDimensions(video, timeoutMs) {
    if (!video) return Promise.resolve(null);
    if (videoHasPicture(video)) return Promise.resolve(video);

    return new Promise((resolve) => {
      const done = () => {
        cleanup();
        resolve(videoHasPicture(video) ? video : null);
      };

      const timer = setTimeout(done, timeoutMs || 3500);

      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('resize', onReady);
        video.removeEventListener('loadeddata', onReady);
      }

      function onReady() {
        if (videoHasPicture(video)) done();
      }

      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('resize', onReady);
      video.addEventListener('loadeddata', onReady);
      onReady();
    });
  }

  function buildPipStageShell(doc, meta) {
    doc.documentElement.style.cssText =
      'margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;';
    doc.body.style.cssText =
      'margin:0;padding:0;background:#000;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;' +
      'width:100%;height:100%;position:relative;';

    const stage = doc.createElement('div');
    stage.style.cssText = 'position:absolute;inset:0;background:#000;overflow:hidden;';

    const mediaWrap = doc.createElement('div');
    mediaWrap.style.cssText = 'position:absolute;inset:0;background:#000;overflow:hidden;';
    stage.appendChild(mediaWrap);

    if (meta?.title) {
      const info = doc.createElement('div');
      info.style.cssText =
        'position:absolute;left:0;right:0;top:0;padding:10px 12px 28px;z-index:2;' +
        'background:linear-gradient(rgba(0,0,0,.82),transparent);color:#fff;pointer-events:none;';
      info.innerHTML =
        `<div style="font-weight:700;font-size:13px;">${escapeHtml(meta.title)}</div>` +
        (meta.artist
          ? `<div style="font-size:11px;color:#ccc;margin-top:2px;">${escapeHtml(meta.artist)}</div>`
          : '');
      stage.appendChild(info);
    }

    const controls = doc.createElement('div');
    controls.style.cssText =
      'position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;gap:8px;padding:10px;' +
      'background:linear-gradient(transparent,rgba(0,0,0,.9));justify-content:center;';

    const btnStyle =
      'border:none;border-radius:8px;padding:8px 14px;font:600 12px system-ui,sans-serif;' +
      'cursor:pointer;color:#fff;background:rgba(255,255,255,.16);min-width:72px;';

    const playBtn = doc.createElement('button');
    playBtn.id = 'ytm-pip-play';
    playBtn.type = 'button';
    playBtn.style.cssText = btnStyle;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');

    const backBtn = doc.createElement('button');
    backBtn.id = 'ytm-pip-back';
    backBtn.type = 'button';
    backBtn.style.cssText = btnStyle;
    backBtn.textContent = '↩ Tab';
    backBtn.setAttribute('aria-label', 'Back to YouTube Music tab');

    controls.appendChild(playBtn);
    controls.appendChild(backBtn);
    stage.appendChild(controls);
    doc.body.appendChild(stage);

    return { stage, mediaWrap, playBtn, backBtn };
  }

  function attachLiveVideoToPip(mediaWrap, sourceVideo) {
    if (sourceVideo.paused) {
      sourceVideo.play().catch(() => {});
    }

    const pipVideo = mediaWrap.ownerDocument.createElement('video');
    pipVideo.autoplay = true;
    pipVideo.playsInline = true;
    pipVideo.muted = true;
    pipVideo.setAttribute('playsinline', '');
    pipVideo.style.cssText =
      'width:100%;height:100%;object-fit:fill;display:block;background:#000;';

    if (typeof sourceVideo.captureStream !== 'function') {
      throw new Error('capture_stream_unavailable');
    }

    const stream = sourceVideo.captureStream(30);
    if (!stream || stream.getVideoTracks().length === 0) {
      throw new Error('capture_stream_no_video');
    }

    pipVideo.srcObject = stream;
    mediaWrap.appendChild(pipVideo);
    pipVideo.play().catch(() => {});

    const syncPlayState = () => {
      if (sourceVideo.paused) pipVideo.pause();
      else pipVideo.play().catch(() => {});
    };
    sourceVideo.addEventListener('play', syncPlayState);
    sourceVideo.addEventListener('pause', syncPlayState);

    return pipVideo;
  }

  function attachPosterToPip(mediaWrap, artUrl, altText) {
    const img = mediaWrap.ownerDocument.createElement('img');
    img.id = DOC_PIP_ART_ID;
    img.src = artUrl;
    img.alt = altText || 'Now playing';
    img.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block;background:#000;';
    mediaWrap.appendChild(img);
    return img;
  }

  let lastPipCanvasMetrics = null;
  let lastPipArtUrl = null;
  let pipGuardCleanup = null;

  function clearNativePipGuard() {
    pipGuardCleanup?.();
    pipGuardCleanup = null;
  }

  async function waitForAlbumArtChange(previousUrl, timeoutMs) {
    const immediate = getAlbumArtUrl();
    if (immediate && immediate !== previousUrl) return immediate;

    const deadline = Date.now() + (timeoutMs || 2000);
    let latest = immediate;
    while (Date.now() < deadline) {
      await waitMs(100);
      latest = getAlbumArtUrl();
      if (latest && latest !== previousUrl) return latest;
    }
    return latest || getAlbumArtUrl();
  }

  async function redrawCanvasPipCover(artUrl) {
    const canvas = document.getElementById(PIP_ART_CANVAS_ID);
    if (!canvas || !artUrl) return false;
    if (artUrl === lastPipArtUrl && canvas.width > 0) return true;

    const metrics =
      lastPipCanvasMetrics || (await resolvePipContentMetrics(null, artUrl));
    lastPipCanvasMetrics = metrics;
    const painted = await drawAlbumArtOnCanvas(canvas, artUrl, metrics);
    if (!painted) return false;
    lastPipArtUrl = artUrl;

    const pipVideo = document.getElementById(PIP_CANVAS_VIDEO_ID);
    if (pipVideo) {
      const active =
        pipVideo.srcObject instanceof MediaStream &&
        pipVideo.srcObject.getVideoTracks().some((t) => t.readyState === 'live');
      if (!active) {
        pipVideo.srcObject = canvas.captureStream(30);
        await pipVideo.play().catch(() => {});
      }
    }
    return true;
  }

  async function swapPictureInPictureTo(video) {
    if (!video || !document.pictureInPictureEnabled) return false;
    // Never put a blank/unready video into PiP — that is the black screen.
    if (!videoHasPicture(video)) return false;
    prepareVideoForPip(video);

    if (video.paused) {
      try {
        await video.play();
      } catch (_) {
        /* continue */
      }
    }

    // Chrome rule: if nothing is in PiP, requestPictureInPicture needs a user gesture.
    // If something IS already in PiP, we can swap to another video without a gesture.
    // So never exit first — request on the target while the current PiP element is live.
    if (document.pictureInPictureElement === video) {
      return true;
    }

    clearNativePipGuard();
    await video.requestPictureInPicture();
    await waitForPictureInPicture(video);
    guardNativePip(video);
    return document.pictureInPictureElement === video;
  }

  /**
   * Settle Song vs Video after a track change.
   * Mixed playlists flip ATV↔OMV after the track event — never commit on the first
   * ATV reading or audio→video PiP stays on the cover forever.
   * Returns 'song' | 'video'.
   */
  async function waitForSettledPipKind(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 3500);
    let songSince = 0;
    let videoSince = 0;

    while (Date.now() < deadline) {
      const avMode = getAvPlaybackMode();
      const video = getPlaybackVideo();
      const hasPic = videoHasPicture(video);
      const looksMv = videoLooksLikeMusicVideo(video);

      // Explicit video with frames → live video PiP
      if (avMode === 'video' && hasPic) {
        if (!videoSince) videoSince = Date.now();
        songSince = 0;
        if (Date.now() - videoSince >= 120) return 'video';
        await waitMs(80);
        continue;
      }

      // Video mode declared, frames not ready yet — keep previous PiP, wait
      if (avMode === 'video') {
        songSince = 0;
        videoSince = 0;
        await waitMs(100);
        continue;
      }

      // Explicit song wins over leftover frames from the previous music video
      // (mixed playlist: video → audio).
      if (avMode === 'song') {
        videoSince = 0;
        if (!songSince) songSince = Date.now();
        // Delay commit so a following OMV flip can win (mixed: audio → video).
        if (Date.now() - songSince >= 700) return 'song';
        await waitMs(80);
        continue;
      }

      // Mode attr lagging: landscape frames mean music video
      if (looksMv) {
        songSince = 0;
        if (!videoSince) videoSince = Date.now();
        if (Date.now() - videoSince >= 120) return 'video';
        await waitMs(80);
        continue;
      }

      if (isSongPlaybackMode()) {
        videoSince = 0;
        if (!songSince) songSince = Date.now();
        if (Date.now() - songSince >= 700) return 'song';
      } else if (hasPic) {
        songSince = 0;
        if (!videoSince) videoSince = Date.now();
        if (Date.now() - videoSince >= 120) return 'video';
      } else {
        songSince = 0;
        videoSince = 0;
      }

      await waitMs(80);
    }

    const avMode = getAvPlaybackMode();
    const video = getPlaybackVideo();
    if (avMode === 'video' || videoLooksLikeMusicVideo(video)) return 'video';
    if (avMode === 'song' || isSongPlaybackMode()) return 'song';
    if (videoHasPicture(video)) return 'video';
    return 'song';
  }

  let pipHandoffWatchId = 0;

  function clearPipHandoffWatch() {
    pipHandoffWatchId += 1;
  }

  /**
   * Mixed playlists often flip Song↔Video after our first settle.
   * Keep watching briefly and upgrade/downgrade PiP without a black flash.
   */
  function startMixedPlaylistPipHandoffWatch() {
    const watchId = ++pipHandoffWatchId;
    const started = Date.now();
    const maxMs = 4500;

    const tick = async () => {
      if (watchId !== pipHandoffWatchId) return;
      if (Date.now() - started > maxMs) return;

      const pipEl = document.pictureInPictureElement;
      if (!(pipEl instanceof HTMLVideoElement)) return;

      const avMode = getAvPlaybackMode();
      const video = getPlaybackVideo();
      const looksMv = videoLooksLikeMusicVideo(video);

      try {
        if (pipEl.id === PIP_CANVAS_VIDEO_ID) {
          // Cover PiP, but track became / flipped to a music video
          if (avMode === 'video' || looksMv) {
            if (videoHasPicture(video)) {
              const ok = await forceUpgradeCanvasPipToVideo();
              if (ok) return;
            } else if (avMode === 'video') {
              const ready = await waitForVideoDimensions(video || getPlaybackVideo(), 1500);
              if (ready && videoHasPicture(ready)) {
                const ok = await forceUpgradeCanvasPipToVideo();
                if (ok) return;
              }
            }
          }
        } else if (avMode === 'song' && !looksMv) {
          // Live video PiP, but track flipped to song/audio
          await forceDowngradeVideoPipToCover();
          return;
        }
      } catch (err) {
        logWarn('Mixed playlist PiP handoff failed:', err?.message);
      }

      if (watchId === pipHandoffWatchId) {
        setTimeout(tick, 250);
      }
    };

    setTimeout(tick, 200);
  }

  async function forceUpgradeCanvasPipToVideo() {
    // Keep canvas cover visible until live video has frames, then swap once.
    beginPipIntentionalSwitch();
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        if (attempt > 0) await waitMs(150 + attempt * 120);

        let video = getPlaybackVideo();
        if (isSongPlaybackMode() || !videoHasPicture(video)) {
          try {
            await trySwitchToVideoMode();
          } catch (_) {
            /* ignore */
          }
          video = getPlaybackVideo();
        }

        if (!video) continue;
        if (!videoHasPicture(video)) {
          video = (await waitForVideoDimensions(video, 1200)) || video;
        }
        if (!videoHasPicture(video)) continue;
        if (!document.pictureInPictureElement) return false;

        const ready = (await waitForVideoDimensions(video, 1500)) || getPlaybackVideo() || video;
        if (!ready || !videoHasPicture(ready)) continue;

        try {
          const ok = await swapPictureInPictureTo(ready);
          if (ok && document.pictureInPictureElement?.id !== PIP_CANVAS_VIDEO_ID) {
            startPipMediaBridge(null);
            return true;
          }
        } catch (err) {
          logWarn('Upgrade canvas PiP → video failed:', err?.message);
        }
      }
      return false;
    } finally {
      endPipIntentionalSwitch();
    }
  }

  async function forceDowngradeVideoPipToCover() {
    // Paint cover on the canvas first, then swap — avoids black PiP between modes.
    const coverArt =
      (await waitForAlbumArtChange(lastPipArtUrl, 2000)) || getAlbumArtUrl();
    if (!coverArt || !document.pictureInPictureElement) return false;

    beginPipIntentionalSwitch();
    try {
      const metrics = await resolvePipContentMetrics(null, coverArt);
      await enterCanvasAlbumArtPip(coverArt, metrics);
      return document.pictureInPictureElement?.id === PIP_CANVAS_VIDEO_ID;
    } catch (err) {
      logWarn('Downgrade video PiP → cover failed:', err?.message);
      return false;
    } finally {
      endPipIntentionalSwitch();
    }
  }

  async function reenterLiveVideoPip() {
    beginPipIntentionalSwitch();
    try {
      let current = getPlaybackVideo();
      if (current && !videoHasPicture(current)) {
        try {
          await trySwitchToVideoMode();
        } catch (_) {
          /* ignore */
        }
        current = getPlaybackVideo();
      }
      if (!current) return false;
      const ready = (await waitForVideoDimensions(current, 2000)) || current;
      if (!ready || !videoHasPicture(ready) || !document.pictureInPictureElement) return false;
      await swapPictureInPictureTo(ready);
      startPipMediaBridge(null);
      return (
        document.pictureInPictureElement instanceof HTMLVideoElement &&
        document.pictureInPictureElement.id !== PIP_CANVAS_VIDEO_ID &&
        videoHasPicture(document.pictureInPictureElement)
      );
    } catch (err) {
      logWarn('Re-enter video PiP failed:', err?.message);
      return false;
    } finally {
      endPipIntentionalSwitch();
    }
  }

  async function updatePipForTrackChange() {
    clearPipHandoffWatch();
    const pipEl = document.pictureInPictureElement;

    // 1) Canvas native PiP (album art): song→song redraw cover; song→video upgrade to live video.
    if (pipEl && pipEl instanceof HTMLVideoElement && pipEl.id === PIP_CANVAS_VIDEO_ID) {
      // Kick cover update immediately for song→song (no black wait).
      const earlyArt = getAlbumArtUrl();
      if (earlyArt && earlyArt !== lastPipArtUrl && getAvPlaybackMode() !== 'video') {
        redrawCanvasPipCover(earlyArt).catch(() => {});
      }

      const kind = await waitForSettledPipKind(3500);

      if (kind === 'video') {
        const upgraded = await forceUpgradeCanvasPipToVideo();
        if (!upgraded) await reenterLiveVideoPip();
        startMixedPlaylistPipHandoffWatch();
        return;
      }

      const nextArt = (await waitForAlbumArtChange(lastPipArtUrl, 2000)) || getAlbumArtUrl();
      if (nextArt) {
        try {
          await redrawCanvasPipCover(nextArt);
        } catch (err) {
          logWarn('Canvas PiP cover update failed:', err?.message);
        }
      }
      // Mixed playlist: OMV may flip after ATV looked settled — upgrade then.
      startMixedPlaylistPipHandoffWatch();
      return;
    }

    // 2) Native video PiP: video→song → album-art PiP; video→video → keep live video.
    if (pipEl && pipEl instanceof HTMLVideoElement && pipEl.id !== PIP_CANVAS_VIDEO_ID) {
      const kind = await waitForSettledPipKind(3500);

      if (kind === 'song') {
        await forceDowngradeVideoPipToCover();
        startMixedPlaylistPipHandoffWatch();
        return;
      }

      const current = getPlaybackVideo();
      const pipLooksFrozen = !videoHasPicture(pipEl);
      const shouldReenter = Boolean(
        current &&
          videoHasPicture(current) &&
          document.pictureInPictureElement &&
          (current !== pipEl || pipLooksFrozen)
      );

      // Only re-enter once the next video has frames (keeps last frame until then).
      if ((shouldReenter || pipLooksFrozen) && current && videoHasPicture(current)) {
        await reenterLiveVideoPip();
      }
      // Mixed playlist: ATV may flip after OMV looked settled — downgrade then.
      startMixedPlaylistPipHandoffWatch();
      return;
    }

    // 3) Document PiP fallback: update the image element if open.
    const docPip = window.documentPictureInPicture?.window;
    if (docPip && !docPip.closed) {
      const docArt =
        (await waitForAlbumArtChange(lastPipArtUrl, 2000)) || getAlbumArtUrl();
      if (docArt) {
        try {
          const img = docPip.document.getElementById(DOC_PIP_ART_ID);
          if (img && img.tagName === 'IMG') {
            img.src = docArt;
            lastPipArtUrl = docArt;
          }
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  function wireDocumentPipControls(pipWindow) {
    const doc = pipWindow.document;
    const playBtn = doc.getElementById('ytm-pip-play');
    const backBtn = doc.getElementById('ytm-pip-back');
    if (!playBtn || !backBtn) return;

    const getMainVideo = () => getMainPlaybackVideo();

    const clickBarPlayPause = () => clickPlayerBarPlayPause();

    const syncPlayIcon = () => {
      const video = getMainVideo();
      const playing = video ? !video.paused : false;
      playBtn.textContent = playing ? '⏸' : '▶';
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    };

    playBtn.addEventListener('click', () => {
      const video = getMainVideo();
      if (video) {
        if (video.paused) video.play().catch(() => clickBarPlayPause());
        else video.pause();
      } else {
        clickBarPlayPause();
      }
      setTimeout(syncPlayIcon, 80);
    });

    backBtn.addEventListener('click', () => {
      ext()?.sendMessage({ type: 'WINDOW_CONTROL', action: 'restore-from-pip' }, () => {
        try {
          pipWindow.close();
        } catch (_) {
          /* ignore */
        }
        stopPipMediaBridge();
      });
    });

    const video = getMainVideo();
    if (video) {
      video.addEventListener('play', syncPlayIcon);
      video.addEventListener('pause', syncPlayIcon);
    }
    syncPlayIcon();
  }

  async function enterDocumentPipWithControls({ artUrl, sourceVideo, meta, metrics }) {
    if (!window.documentPictureInPicture?.requestWindow) {
      throw new Error('document_pip_unavailable');
    }

    const contentRatio = metrics?.ratio || 1;
    const size = pipSizeFromRatio(contentRatio);
    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: size.width,
      height: size.height
    });

    const doc = pipWindow.document;
    const { mediaWrap } = buildPipStageShell(doc, meta);
    bindPipWindowAspectRatio(pipWindow, contentRatio);

    if (sourceVideo && videoHasPicture(sourceVideo)) {
      try {
        attachLiveVideoToPip(mediaWrap, sourceVideo);
      } catch (err) {
        logWarn('PiP live video failed, using poster:', err?.message);
        if (artUrl) attachPosterToPip(mediaWrap, artUrl, meta?.title);
      }
    } else if (artUrl) {
      attachPosterToPip(mediaWrap, artUrl, meta?.title);
    } else {
      throw new Error('no_pip_media');
    }

    wireDocumentPipControls(pipWindow);
    startPipMediaBridge(null);
    pipWindow.addEventListener('pagehide', stopPipMediaBridge, { once: true });
    return pipWindow;
  }

  async function enterAlbumArtDocumentPip(artUrl, meta, metrics) {
    return enterDocumentPipWithControls({ artUrl, sourceVideo: null, meta, metrics });
  }

  async function enterCanvasAlbumArtPip(artUrl, metrics) {
    let canvas = document.getElementById(PIP_ART_CANVAS_ID);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = PIP_ART_CANVAS_ID;
      canvas.style.cssText = 'position:fixed;left:-9999px;top:-9999px;pointer-events:none;';
      document.documentElement.appendChild(canvas);
    }

    lastPipCanvasMetrics = metrics;
    const painted = await drawAlbumArtOnCanvas(canvas, artUrl, metrics);
    if (!painted) throw new Error('cover_paint_failed');
    lastPipArtUrl = artUrl;

    let pipVideo = document.getElementById(PIP_CANVAS_VIDEO_ID);
    if (!pipVideo) {
      pipVideo = document.createElement('video');
      pipVideo.id = PIP_CANVAS_VIDEO_ID;
      pipVideo.muted = true;
      pipVideo.playsInline = true;
      pipVideo.setAttribute('playsinline', '');
      pipVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.documentElement.appendChild(pipVideo);
    }

    // Reuse live canvas stream when possible — rebinding srcObject flashes black in PiP.
    const streamLive =
      pipVideo.srcObject instanceof MediaStream &&
      pipVideo.srcObject.getVideoTracks().some((t) => t.readyState === 'live');
    if (!streamLive) {
      pipVideo.srcObject = canvas.captureStream(30);
    }
    prepareVideoForPip(pipVideo);
    await pipVideo.play();
    // Let captureStream emit the painted frame before swapping into PiP.
    await waitMs(40);

    // Prefer swap when PiP is already open (track-change pathways; no user gesture).
    if (document.pictureInPictureElement && document.pictureInPictureElement !== pipVideo) {
      clearNativePipGuard();
      await pipVideo.requestPictureInPicture();
      await waitForPictureInPicture(pipVideo);
    } else if (document.pictureInPictureElement !== pipVideo) {
      await pipVideo.requestPictureInPicture();
      await waitForPictureInPicture(pipVideo);
    }

    guardNativePip(pipVideo);
    startPipMediaBridge(pipVideo);
    return pipVideo;
  }

  async function startVideoPictureInPicture(video) {
    prepareVideoForPip(video);

    if (video.paused) {
      try {
        await video.play();
      } catch (_) {
        /* continue — PiP may still work */
      }
    }

    await video.requestPictureInPicture();
    await waitForPictureInPicture(video);
    guardNativePip(video);
  }

  /** Re-enter PiP briefly if the page tries to cancel it (PiP View extension pattern). */
  function guardNativePip(video, durationMs) {
    if (!video) return;
    clearNativePipGuard();
    const guardUntil = Date.now() + (durationMs || 2000);

    function onLeave(event) {
      if (event.target !== video) return;
      if (Date.now() > guardUntil) {
        video.removeEventListener('leavepictureinpicture', onLeave);
        return;
      }
      // Do not force canvas proxy back if we intentionally switched PiP sources.
      if (video.id === PIP_CANVAS_VIDEO_ID) return;
      prepareVideoForPip(video);
      video.requestPictureInPicture().catch(() => {});
    }

    video.addEventListener('leavepictureinpicture', onLeave);
    const timer = setTimeout(() => {
      video.removeEventListener('leavepictureinpicture', onLeave);
      if (pipGuardCleanup) pipGuardCleanup = null;
    }, (durationMs || 2000) + 200);

    pipGuardCleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('leavepictureinpicture', onLeave);
    };
  }

  async function enterBestPip() {
    tryExpandPlayerSync();
    await waitMs(60);

    let video = getPlaybackVideo();
    const artUrl = getAlbumArtUrl();
    const meta = getNowPlayingMeta();
    let songMode = isSongPlaybackMode();

    await saveWindowStateBeforePip();

    // If the current video already has frames, treat this as video mode even if
    // the page hasn't updated playback-mode yet (prevents video PiP turning into a still).
    if (video && videoHasPicture(video)) {
      songMode = false;
    }

    if (!songMode && video) {
      if (!videoHasPicture(video)) {
        await trySwitchToVideoMode();
        await waitMs(600);
        video = getPlaybackVideo();
        songMode = isSongPlaybackMode();
        if (video && videoHasPicture(video)) songMode = false;
      }
      video = (await waitForVideoDimensions(video, 3500)) || video;
    }

    const coverUrl = artUrl || getAlbumArtUrl();
    const useLiveVideo = !songMode && videoHasPicture(video);

    // Native video PiP — same model as "Picture in Picture - PiP View":
    // Chrome locks the outer window aspect ratio; the video never shrinks inside.
    if (useLiveVideo && canUseVideoPip(video)) {
      try {
        await startVideoPictureInPicture(video);
        return;
      } catch (err) {
        logWarn('Native video PiP failed:', err?.message);
      }
    }

    // Song mode: native PiP via canvas (outer window ratio locked by Chrome).
    if (coverUrl && document.pictureInPictureEnabled) {
      try {
        const metrics = await resolvePipContentMetrics(null, coverUrl);
        await enterCanvasAlbumArtPip(coverUrl, metrics);
        return;
      } catch (err) {
        logWarn('Canvas native PiP failed:', err?.message);
      }
    }

    // Fallback: Document PiP with custom controls (album art only).
    if (coverUrl && window.documentPictureInPicture?.requestWindow) {
      const metrics = await resolvePipContentMetrics(null, coverUrl);
      await enterDocumentPipWithControls({
        artUrl: coverUrl,
        sourceVideo: null,
        meta,
        metrics
      });
      return;
    }

    throw new Error('no_pip_media');
  }

  function triggerPipAndMinimize() {
    if (document.pictureInPictureElement) {
      stopPipMediaBridge();
      document
        .exitPictureInPicture()
        .then(() => setPipStatus('PiP', false))
        .catch((err) => logWarn('Exit PiP failed:', err?.message));
      return;
    }

    if (window.documentPictureInPicture?.window && !window.documentPictureInPicture.window.closed) {
      stopPipMediaBridge();
      window.documentPictureInPicture.window.close();
      setPipStatus('PiP', false);
      return;
    }

    if (!document.pictureInPictureEnabled && !window.documentPictureInPicture) {
      setPipStatus('PiP not supported', false);
      return;
    }

    if (!getPlaybackVideo() && !getAlbumArtUrl()) {
      setPipStatus('Play a song first', false);
      return;
    }

    setPipStatus('PiP…', true);

    const finishPip = () => {
      minimizeForPip();
      setPipStatus('PiP', false);
    };

    enterBestPip()
      .then(() => waitMs(120))
      .then(finishPip)
      .catch((err) => {
        logWarn('PiP failed:', err?.message);
        setPipStatus('PiP failed — play a song', false);
      });
  }

  function pauseNowPlaying() {
    const video =
      document.querySelector('video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video');
    if (video && !video.paused) {
      try {
        video.pause();
      } catch (_) {
        /* ignore */
      }
    }
    const barBtn = document.querySelector(
      'ytmusic-player-bar .play-pause-button, ytmusic-player-bar #play-pause-button'
    );
    if (barBtn?.getAttribute('aria-label')?.toLowerCase().includes('pause')) {
      barBtn.click();
    }
  }

  function closeDisplayMenu() {
    if (displayMenuOutsideHandler) {
      document.removeEventListener('pointerdown', displayMenuOutsideHandler, true);
      displayMenuOutsideHandler = null;
    }
    if (displayMenu) {
      displayMenu.remove();
      displayMenu = null;
    }
  }

  function setWindowDisplay(mode) {
    closeDisplayMenu();
    if (!ext()?.isContextValid()) return;
    ext().sendMessage({ type: 'WINDOW_CONTROL', action: 'set-display', display: mode }, (response) => {
      if (!response?.ok) logWarn('Display mode failed:', mode, response?.reason);
    });
  }

  function toggleDisplayMenu() {
    if (displayMenu) {
      closeDisplayMenu();
      return;
    }

    if (!dock) return;

    displayMenu = document.createElement('div');
    displayMenu.className = 'ytm-display-menu';
    displayMenu.setAttribute('role', 'menu');
    displayMenu.setAttribute('aria-label', 'Window display mode');

    const modes = [
      {
        id: 'maximized',
        label: 'Max',
        title: 'Maximized window',
        icon: '<path d="M4 4h16v16H4V4zm2 2v12h12V6H6z"/>'
      },
      {
        id: 'normal',
        label: 'Win',
        title: 'Normal window',
        icon: '<path d="M3 5h18v12H3V5zm2 2v8h14V7H5z"/>'
      },
      {
        id: 'minimized',
        label: '—',
        title: 'Minimize to taskbar',
        icon: '<path d="M5 11h14v2H5z"/>'
      }
    ];

    modes.forEach((mode) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ytm-display-menu-btn';
      btn.dataset.display = mode.id;
      btn.title = mode.title;
      btn.setAttribute('aria-label', mode.title);
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${mode.icon}</svg><span>${mode.label}</span>`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setWindowDisplay(mode.id);
      });
      displayMenu.appendChild(btn);
    });

    dock.appendChild(displayMenu);

    displayMenuOutsideHandler = (event) => {
      if (!displayMenu) return;
      if (dock.contains(event.target)) return;
      closeDisplayMenu();
    };
    setTimeout(() => {
      document.addEventListener('pointerdown', displayMenuOutsideHandler, true);
    }, 0);
  }

  /** Cycle window: maximized → normal → taskbar. */
  function cycleBrowserDisplay() {
    if (!ext()?.isContextValid()) return;
    ext().sendMessage({ type: 'WINDOW_CONTROL', action: 'cycle-display' }, (response) => {
      if (!response?.ok) logWarn('Window cycle failed');
    });
  }

  function controlBrowserWindow(action) {
    if (!ext()?.isContextValid()) return;
    ext().sendMessage({ type: 'WINDOW_CONTROL', action }, (response) => {
      if (!response?.ok) logWarn('Window control failed:', action, response?.reason);
    });
  }

  function triggerRandomPlay() {
    if (randomPlayBusy) return;
    if (!window.YtmListenHistory) {
      setRandomStatus('No history yet', false);
      return;
    }

    randomPlayBusy = true;
    setRandomStatus('Playing…', true);

    window.YtmListenHistory.playRandom((result) => {
      randomPlayBusy = false;
      if (result?.ok) {
        setRandomStatus('Random', false);
      } else if (result?.reason === 'no_history') {
        setRandomStatus('Play songs first', false);
      } else {
        setRandomStatus('Random failed', false);
      }
    });
  }

  function onVerticalDragStart(event) {
    const vdrag = event.currentTarget;
    if (!dock || !vdrag?.classList?.contains('ytm-dock-vdrag')) return;
    isVerticalDragging = true;
    dragMoved = false;
    dragStartY = event.clientY;
    dragStartPercent = config.dockTopPercent;
    try {
      vdrag.setPointerCapture(event.pointerId);
    } catch (_) {
      /* ignore */
    }
    event.preventDefault();
  }

  function onVerticalDragMove(event) {
    if (!isVerticalDragging || !dock) return;

    const deltaY = event.clientY - dragStartY;
    if (Math.abs(deltaY) > 2) dragMoved = true;
    const deltaPercent = (deltaY / window.innerHeight) * 100;
    config.dockTopPercent = clampTopPercent(dragStartPercent + deltaPercent);
    applyDockPosition();
  }

  function onVerticalDragEnd(event) {
    if (!isVerticalDragging || !dock) return;
    isVerticalDragging = false;
    const vdrag = event.currentTarget;
    try {
      vdrag.releasePointerCapture(event.pointerId);
    } catch (_) {
      /* ignore */
    }
    saveDockTopPercent(config.dockTopPercent);
    setTimeout(() => {
      dragMoved = false;
    }, 0);
  }

  function handleDockAction(action) {
    if (action === 'display-menu') {
      toggleDisplayMenu();
      return;
    }
    if (action === 'fullscreen') {
      toggleDisplayMenu();
      return;
    }
    if (action === 'minimize') {
      setWindowDisplay('minimized');
      return;
    }
    if (action === 'close') {
      pauseNowPlaying();
      controlBrowserWindow('close');
      return;
    }
    if (action === 'pip') {
      triggerPipAndMinimize();
      return;
    }
    if (action === 'random') {
      triggerRandomPlay();
    }
  }

  function onDockButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const action = target.getAttribute('data-action');
    if (!action) return;
    handleDockAction(action);
  }

  function createDock() {
    const existing = document.getElementById(DOCK_ID);
    if (existing) {
      existing.remove();
      dock = null;
    }

    dock = document.createElement('div');
    dock.id = DOCK_ID;
    dock.className = 'ytm-float-dock';
    dock.setAttribute('role', 'toolbar');
    dock.setAttribute('aria-label', 'Browser window controls');
    dock.innerHTML = `
      <button type="button" class="ytm-dock-vdrag" title="Drag up/down" aria-label="Move dock up or down">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M8 9h8v2H8V9zm0 4h8v2H8v-2z"/>
        </svg>
      </button>
      <div class="ytm-dock-window-controls">
        <button type="button" class="ytm-dock-btn ytm-dock-max" data-action="display-menu" title="Choose window mode" aria-label="Choose window display mode" aria-haspopup="menu">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 7h4V5H5v6h2V7zm10 0v4h2V5h-6v2h4zM7 17v-4H5v6h6v-2H7zm10 0h-4v2h6v-6h-2v4z"/></svg>
        </button>
        <button type="button" class="ytm-dock-btn ytm-dock-min" data-action="minimize" title="Minimize to taskbar" aria-label="Minimize window to taskbar">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 11h14v2H5z"/></svg>
        </button>
        <button type="button" class="ytm-dock-btn ytm-dock-close" data-action="close" title="Close tab" aria-label="Close tab">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.71 2.88 18.3 9.17 12 2.88 5.71 4.29 4.3 10.59 10.6l6.3-6.3z"/></svg>
        </button>
      </div>
        <button type="button" class="ytm-dock-btn ytm-dock-pip" data-action="pip" title="PiP with play/pause + back to tab" aria-label="Picture in Picture with controls">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19 7h-8v6h8V7zm0-2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h8zM5 17h6v2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2v2H5v12z"/>
        </svg>
      </button>
      <button type="button" class="ytm-dock-btn ytm-dock-random" data-action="random" title="Random from your listens" aria-label="Play random song from your listen history">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 5.17-5.17L10.59 9.17zM14.83 4H18v3.17l-1.59-1.59L14.83 4zM14.83 12.83 13.41 14.24 16.66 17.5 14.83 19.34 18 19.34v-3.17l-1.59 1.59-1.58-1.58zM10 18l-6-6 1.41-1.41L10 15.17l4.59-4.58L16 12l-6 6z"/>
        </svg>
      </button>
    `;

    const vdrag = dock.querySelector('.ytm-dock-vdrag');
    vdrag.addEventListener('pointerdown', onVerticalDragStart);
    vdrag.addEventListener('pointermove', onVerticalDragMove);
    vdrag.addEventListener('pointerup', onVerticalDragEnd);
    vdrag.addEventListener('pointercancel', onVerticalDragEnd);

    dock.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', onDockButtonClick);
    });

    document.documentElement.appendChild(dock);
    applyDockPosition();
    return dock;
  }

  function removeDock() {
    closeDisplayMenu();
    if (dock) {
      dock.remove();
      dock = null;
    }
    stopMediaSessionPolling();
  }

  function maybeAutoWindowFullscreen() {
    if (sessionStorage.getItem(SESSION_WINDOW_FS_KEY) === '1') return;
    sessionStorage.setItem(SESSION_WINDOW_FS_KEY, '1');
    ext()?.sendMessage({ type: 'WINDOW_CONTROL', action: 'enter-fullscreen' });
  }

  function initDock() {
    if (!config.floatEnabled) {
      removeDock();
      return;
    }

    createDock();
    maybeAutoWindowFullscreen();
  }

  function init() {
    cleanupLegacyRadioAndShuffle();
    attachMediaSessionSync();
    startMediaSessionPolling();

    document.addEventListener('ytm-track-changed', () => {
      attachMediaSessionSync();
      syncWindowsMediaSession();
      updatePipForTrackChange();
    });

    document.addEventListener('yt-navigate-finish', () => {
      setTimeout(() => {
        attachMediaSessionSync();
        syncWindowsMediaSession();
      }, 400);
    });

    loadSettings(() => {
      initDock();
      log('Float dock ready — window only, top', config.dockTopPercent + '%');
    });

    ext()?.onStorageChanged((changes, area) => {
      if (area !== 'local') return;

      if (changes[SETTINGS.floatEnabled]) {
        config.floatEnabled = changes[SETTINGS.floatEnabled].newValue !== false;
        initDock();
      }

      if (changes[SETTINGS.dockTopPercent]) {
        config.dockTopPercent = clampTopPercent(changes[SETTINGS.dockTopPercent].newValue);
        applyDockPosition();
      }
    });

    window.addEventListener('resize', applyDockPosition);

    window.addEventListener('beforeunload', pauseNowPlaying);
    window.addEventListener('pagehide', pauseNowPlaying);

    document.addEventListener('enterpictureinpicture', (event) => {
      setPipStatus('PiP', false);
      const pipVideo = event.target;
      if (pipVideo instanceof HTMLVideoElement) {
        startPipMediaBridge(pipVideo.id === PIP_CANVAS_VIDEO_ID ? pipVideo : null);
      } else {
        startPipMediaBridge(null);
      }
    });
    document.addEventListener('leavepictureinpicture', () => {
      setPipStatus('PiP', false);
      // Temporary exit while switching canvas↔video PiP on track change.
      if (pipIntentionalSwitch) {
        return;
      }
      // User closed PiP intentionally — allow main window focus/restore again.
      if (ext()?.isContextValid()) {
        ext().sendMessage({ type: 'CLEAR_PIP_MINIMIZE' }, () => {
          stopPipMediaBridge({ focusTab: false });
        });
        return;
      }
      stopPipMediaBridge({ focusTab: false });
    });

    ext()?.onInvalidated(() => {
      /* Keep dock visible; only show reload banner when extension is truly reloaded */
    });
  }

  ext()?.onMessage((message, _sender, sendResponse) => {
    if (message.type === 'PLAY_RANDOM') {
      triggerRandomPlay();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'GET_RANDOM_SETTINGS') {
      sendResponse({
        floatEnabled: config.floatEnabled,
        dockTopPercent: config.dockTopPercent
      });
      return true;
    }

    if (message.type === 'SET_RANDOM_SETTINGS') {
      config.floatEnabled = message.floatEnabled !== false;
      if (message.dockTopPercent !== undefined) {
        config.dockTopPercent = clampTopPercent(message.dockTopPercent);
      }

      ext()?.storageSet(
        {
          [SETTINGS.floatEnabled]: config.floatEnabled,
          [SETTINGS.dockTopPercent]: config.dockTopPercent
        },
        () => {
          initDock();
          sendResponse({ ok: true });
        }
      );
      return true;
    }

    if (message.type === 'SET_DOCK_TOP_PERCENT') {
      config.dockTopPercent = clampTopPercent(message.dockTopPercent);
      applyDockPosition();
      saveDockTopPercent(config.dockTopPercent);
      sendResponse({ ok: true, dockTopPercent: config.dockTopPercent });
      return true;
    }

    return false;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.YtmFloatRandom = {
    triggerRandomPlay,
    triggerPipAndMinimize,
    pauseNowPlaying,
    initDock,
    controlBrowserWindow,
    cycleBrowserDisplay,
    toggleBrowserFullscreen: toggleDisplayMenu,
    applyDockPosition
  };
})();
