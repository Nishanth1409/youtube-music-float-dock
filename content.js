/**
 * YouTube Music Float Dock — content script
 *
 * Operates exclusively on https://music.youtube.com/*
 * Shows audio and video normally; requests the highest playback quality available.
 */

(function () {
  'use strict';

  const SELECTORS = {
    playerBar: 'ytmusic-player-bar',
    title: [
      'ytmusic-player-bar .title',
      'ytmusic-player-bar yt-formatted-string.title',
      '.title.ytmusic-player-bar'
    ],
    artist: [
      'ytmusic-player-bar .byline',
      'ytmusic-player-bar yt-formatted-string.byline',
      '.byline.ytmusic-player-bar'
    ],
    moviePlayer: '#movie_player',
    playerPage: 'ytmusic-player-page',
    avToggle: 'ytmusic-av-toggle'
  };

  const PLAYBACK_MODE = {
    SONG: 'ATV_PREFERRED',
    VIDEO: 'OMV_PREFERRED'
  };

  const STORAGE_KEY = 'hqModeEnabled';
  const LEGACY_STORAGE_KEY = 'audioOnlyEnabled';
  const LOG_PREFIX = '[YTM Float]';

  const QUALITY_PREFERENCE = [
    'highres',
    'hd2160',
    'hd1440',
    'hd1080',
    'hd720',
    'large',
    'medium',
    'small',
    'tiny'
  ];

  const QUALITY_LABELS = {
    highres: '4K+',
    hd2160: '2160p',
    hd1440: '1440p',
    hd1080: '1080p',
    hd720: '720p',
    large: '480p',
    medium: '360p',
    small: '240p',
    tiny: '144p',
    auto: 'Auto'
  };

  const QUALITY_TO_HEIGHT = {
    highres: 2160,
    hd2160: 2160,
    hd1440: 1440,
    hd1080: 1080,
    hd720: 720,
    large: 480,
    medium: 360,
    small: 240,
    tiny: 144
  };

  const STORAGE_QUALITY_KEY = 'yt-player-quality';
  const UI_SELECTORS = {
    settingsButton: '.ytp-settings-button',
    settingsMenuItem: '.ytp-settings-menu .ytp-menuitem',
    qualityMenuItem: '.ytp-quality-menu .ytp-menuitem'
  };

  const DEBOUNCE_MS = 400;
  const PLAYER_READY_DELAY_MS = 1200;
  const QUALITY_RETRY_STEPS = [1000, 2500, 5000, 10000];
  const OBSERVER_THROTTLE_MS = 600;
  const UI_QUALITY_COOLDOWN_MS = 8000;

  let enabled = false;
  let debounceTimer = null;
  let observerThrottleTimer = null;
  let qualityRetryTimers = [];
  let lastSeenVideoId = '';
  let lastAppliedQuality = '';
  let lastTargetQuality = '';
  let lastUiQualityAttemptAt = 0;
  let lastUiQualityVideoId = '';
  let storageGuardInstalled = false;
  let lastReportedStatus = null;
  let lastReportedAt = 0;
  const STATUS_PUSH_MIN_MS = 2000;
  let bindPlayerIntervalId = null;

  const ext = () => window.YtmExtension;

  function log(...args) {
    if (typeof console !== 'undefined' && console.debug) {
      console.debug(LOG_PREFIX, ...args);
    }
  }

  function logWarn(...args) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(LOG_PREFIX, ...args);
    }
  }

  function queryFirst(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function getMoviePlayer() {
    return document.getElementById('movie_player') || document.querySelector(SELECTORS.moviePlayer);
  }

  function getTrackTitle() {
    const el = queryFirst(SELECTORS.title);
    return el ? el.textContent.trim() : '';
  }

  function getTrackArtist() {
    const el = queryFirst(SELECTORS.artist);
    return el ? el.textContent.trim() : '';
  }

  function getCurrentVideoId() {
    const player = getMoviePlayer();
    if (player && typeof player.getVideoData === 'function') {
      try {
        const data = player.getVideoData();
        if (data && data.video_id) return data.video_id;
      } catch (_) {
        /* player not ready */
      }
    }

    const video = document.querySelector('video');
    if (video && video.src) {
      const match = video.src.match(/[?&]v=([^&]+)/);
      if (match) return match[1];
    }

    const title = getTrackTitle();
    const artist = getTrackArtist();
    if (title || artist) return `${title}::${artist}`;
    return '';
  }

  function getPlaybackType() {
    const toggle = document.querySelector(SELECTORS.avToggle);
    if (!toggle) return 'Unknown';

    const mode = toggle.getAttribute('playback-mode');
    if (mode === PLAYBACK_MODE.SONG) return 'Song';
    if (mode === PLAYBACK_MODE.VIDEO) return 'Video';
    return 'Unknown';
  }

  function isPlayerReady() {
    const player = getMoviePlayer();
    if (!player) return false;

    if (typeof player.getPlayerState === 'function') {
      try {
        const state = player.getPlayerState();
        return state !== undefined && state !== -1;
      } catch (_) {
        return false;
      }
    }

    const video = document.querySelector('video');
    return Boolean(video && video.readyState >= 2);
  }

  function formatQuality(level) {
    if (!level) return '—';
    return QUALITY_LABELS[level] || level;
  }

  function getHtmlVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video') || document.querySelector('video');
  }

  function getVideoResolution() {
    const video = getHtmlVideo();
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    return { width: video.videoWidth, height: video.videoHeight };
  }

  function resolutionLabel(resolution) {
    if (!resolution) return '—';
    return `${resolution.width}×${resolution.height}`;
  }

  function parseQualityHeight(label) {
    if (!label) return 0;
    const match = String(label).match(/(\d{3,4})\s*p/i);
    return match ? parseInt(match[1], 10) : 0;
  }

  function qualityRank(level) {
    if (!level) return -1;
    if (QUALITY_TO_HEIGHT[level]) return QUALITY_TO_HEIGHT[level];
    return parseQualityHeight(level);
  }

  function installStorageQualityGuard() {
    if (storageGuardInstalled) return;
    storageGuardInstalled = true;

    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (enabled && key === STORAGE_QUALITY_KEY && lastTargetQuality) {
        const now = Date.now();
        value = JSON.stringify({
          data: lastTargetQuality,
          creation: now,
          expiration: now + 31536000000
        });
      }
      return originalSetItem.call(this, key, value);
    };
  }

  function persistQualityPreference(qualityLevel) {
    if (!qualityLevel || qualityLevel === 'auto') return;
    lastTargetQuality = qualityLevel;

    try {
      const now = Date.now();
      const payload = JSON.stringify({
        data: qualityLevel,
        creation: now,
        expiration: now + 31536000000
      });
      localStorage.setItem(STORAGE_QUALITY_KEY, payload);

      const numeric = QUALITY_TO_HEIGHT[qualityLevel];
      if (numeric) {
        localStorage.setItem(STORAGE_QUALITY_KEY, JSON.stringify({
          data: JSON.stringify({ quality: numeric, previousQuality: numeric }),
          creation: now,
          expiration: now + 31536000000
        }));
      }
      log('Stored video quality preference:', qualityLevel);
    } catch (err) {
      logWarn('Could not persist quality preference:', err.message);
    }
  }

  function getCurrentQuality(player) {
    if (!player) return null;

    try {
      if (typeof player.getPlaybackQuality === 'function') {
        return player.getPlaybackQuality();
      }
      if (typeof player.getPlaybackQualityLabel === 'function') {
        return player.getPlaybackQualityLabel();
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function getBestAvailableQuality(player) {
    if (!player) return null;

    try {
      if (typeof player.getAvailableQualityLevels === 'function') {
        const available = player.getAvailableQualityLevels() || [];
        if (available.length > 0) {
          const best = QUALITY_PREFERENCE.find((q) => available.includes(q));
          if (best) return best;
        }
      }

      if (typeof player.getMaxPlaybackQuality === 'function') {
        const maxQ = player.getMaxPlaybackQuality();
        if (maxQ && maxQ !== 'unknown') return maxQ;
      }
    } catch (_) {
      /* ignore */
    }

    return null;
  }

  function reloadPlayerAtCurrentTime(player) {
    if (!player || typeof player.getVideoData !== 'function') return false;

    try {
      const data = player.getVideoData();
      const time = typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : 0;
      if (!data || !data.video_id) return false;

      if (typeof player.loadVideoById === 'function') {
        player.loadVideoById(data.video_id, time);
        log('Reloaded player to apply video quality at', time.toFixed(1), 's');
        return true;
      }
    } catch (err) {
      logWarn('Player reload failed:', err.message);
    }

    return false;
  }

  function applyPlayerQuality(player, targetQuality) {
    if (!player || !targetQuality) return false;
    let applied = false;

    try {
      persistQualityPreference(targetQuality);

      if (typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(targetQuality, targetQuality);
        applied = true;
      }

      const current = getCurrentQuality(player);
      if (typeof player.setPlaybackQuality === 'function' && current !== targetQuality) {
        player.setPlaybackQuality(targetQuality);
        applied = true;
        log('Player API quality:', current, '→', targetQuality);
      }

      if (typeof player.getMaxPlaybackQuality === 'function' && typeof player.setPlaybackQuality === 'function') {
        const maxQ = player.getMaxPlaybackQuality();
        if (maxQ && maxQ !== 'unknown' && maxQ !== getCurrentQuality(player)) {
          player.setPlaybackQuality(maxQ);
          persistQualityPreference(maxQ);
          targetQuality = maxQ;
          applied = true;
          log('Applied max player quality:', maxQ);
        }
      }
    } catch (err) {
      logWarn('Player quality API failed:', err.message);
    }

    lastAppliedQuality = getCurrentQuality(player) || targetQuality;
    return applied;
  }

  function clickHighestQualityMenuItem() {
    const items = [...document.querySelectorAll(UI_SELECTORS.qualityMenuItem)];
    if (items.length === 0) return null;

    let bestItem = null;
    let bestHeight = -1;

    for (const item of items) {
      const label = item.innerText || item.textContent || '';
      if (/^\s*auto\s*$/i.test(label)) continue;
      const height = parseQualityHeight(label);
      if (height > bestHeight) {
        bestHeight = height;
        bestItem = item;
      }
    }

    if (!bestItem) {
      bestItem = items.find((item) => !/auto/i.test(item.innerText || '')) || items[0];
    }

    const label = (bestItem.innerText || bestItem.textContent || '').trim();
    bestItem.click();
    log('Selected video quality from menu:', label);
    return label;
  }

  function selectHighestQualityViaUI() {
    const videoId = getCurrentVideoId();
    const now = Date.now();

    if (
      videoId &&
      videoId === lastUiQualityVideoId &&
      now - lastUiQualityAttemptAt < UI_QUALITY_COOLDOWN_MS
    ) {
      return false;
    }

    const settingsButton = document.querySelector(UI_SELECTORS.settingsButton);
    if (!settingsButton) return false;

    const menuItems = [...document.querySelectorAll(UI_SELECTORS.settingsMenuItem)];
    const qualityEntry = menuItems.find((item) => /quality/i.test(item.innerText || item.textContent || ''));
    if (!qualityEntry) return false;

    lastUiQualityAttemptAt = now;
    lastUiQualityVideoId = videoId;

    settingsButton.click();
    qualityEntry.click();

    const selected = clickHighestQualityMenuItem();
    if (!selected) {
      settingsButton.click();
      return false;
    }

    return true;
  }

  function needsHigherVideoQuality(targetQuality) {
    if (!targetQuality) return false;

    const targetHeight = qualityRank(targetQuality);
    if (targetHeight <= 0) return false;

    const resolution = getVideoResolution();
    if (!resolution) return true;

    return resolution.height < targetHeight - 40;
  }

  function maximizePlaybackQuality() {
    const player = getMoviePlayer();
    if (!player) {
      return { current: null, target: null, applied: false, resolution: getVideoResolution() };
    }

    const target = getBestAvailableQuality(player);
    let applied = false;

    if (target) {
      applied = applyPlayerQuality(player, target);

      const current = getCurrentQuality(player);
      if (current !== target && needsHigherVideoQuality(target)) {
        reloadPlayerAtCurrentTime(player);
        applied = true;
      }
    }

    if (needsHigherVideoQuality(target)) {
      const uiSelected = selectHighestQualityViaUI();
      if (uiSelected) applied = true;
    }

    const resolution = getVideoResolution();
    const current = getCurrentQuality(player) || lastAppliedQuality;

    return {
      current,
      target: target || lastTargetQuality,
      applied,
      resolution,
      videoQualityLabel: resolution ? `${resolution.height}p` : formatQuality(current)
    };
  }

  function buildStatus() {
    const player = getMoviePlayer();
    const quality = getCurrentQuality(player) || lastAppliedQuality;
    const resolution = getVideoResolution();

    return {
      enabled,
      title: getTrackTitle() || '—',
      artist: getTrackArtist() || '—',
      playbackType: getPlaybackType(),
      quality: quality || '—',
      qualityLabel: resolution ? `${resolution.height}p` : formatQuality(quality),
      videoResolution: resolutionLabel(resolution),
      targetQuality: formatQuality(lastTargetQuality || quality),
      videoId: getCurrentVideoId(),
      onYouTubeMusic: true
    };
  }

  function getAlbumArtUrlForMediaSession() {
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
      if (src && !src.startsWith('data:') && src.startsWith('http')) return src;
    }
    return null;
  }

  function syncWindowsMediaSessionFromStatus(status) {
    if (!navigator.mediaSession) return;
    if (!status?.onYouTubeMusic) return;

    const artUrl = getAlbumArtUrlForMediaSession();
    const artwork = artUrl
      ? [
          { src: artUrl, sizes: '96x96', type: 'image/jpeg' },
          { src: artUrl, sizes: '256x256', type: 'image/jpeg' },
          { src: artUrl, sizes: '512x512', type: 'image/jpeg' }
        ]
      : [];

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: status.title && status.title !== '—' ? status.title : 'YouTube Music',
        artist: status.artist && status.artist !== '—' ? status.artist : '',
        // Windows media UI surfaces this field; use it to reflect Song vs Video.
        album: status.playbackType ? `YouTube Music (${status.playbackType})` : 'YouTube Music',
        artwork
      });
    } catch (_) {
      /* ignore */
    }

    // Prefer the real playback video (ignore hidden PiP canvas proxy, if present).
    const videos = [...document.querySelectorAll('video')];
    const video =
      videos.find((v) => v.id !== 'ytm-pip-canvas-video') ||
      videos[0] ||
      null;
    if (video) {
      try {
        navigator.mediaSession.playbackState = video.paused ? 'paused' : 'playing';
      } catch (_) {
        /* ignore */
      }
      if (typeof navigator.mediaSession.setPositionState === 'function') {
        try {
          const duration = Number(video.duration);
          const position = Number(video.currentTime);
          if (Number.isFinite(duration) && duration > 0 && Number.isFinite(position) && position >= 0) {
            navigator.mediaSession.setPositionState({
              duration,
              position,
              playbackRate: Number(video.playbackRate) || 1
            });
          }
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  function clickPlayerBarButton(selectors) {
    const btn = document.querySelector(selectors);
    if (!btn) return false;
    btn.click();
    return true;
  }

  function clickPlayPause() {
    return clickPlayerBarButton(
      'ytmusic-player-bar .play-pause-button, ytmusic-player-bar #play-pause-button, .ytp-play-button'
    );
  }

  function clickNext() {
    return clickPlayerBarButton(
      'ytmusic-player-bar .next-button, ytmusic-player-bar #next-button, .ytp-next-button'
    );
  }

  function clickPrevious() {
    return clickPlayerBarButton(
      'ytmusic-player-bar .previous-button, ytmusic-player-bar #previous-button, .ytp-prev-button'
    );
  }

  let mediaActionHandlersBound = false;
  function bindMediaActionHandlers() {
    if (mediaActionHandlersBound) return;
    if (!navigator.mediaSession?.setActionHandler) return;
    mediaActionHandlersBound = true;

    const safeBind = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (_) {
        /* ignore */
      }
    };

    safeBind('play', () => clickPlayPause());
    safeBind('pause', () => clickPlayPause());
    safeBind('stop', () => clickPlayPause());
    safeBind('nexttrack', () => clickNext());
    safeBind('previoustrack', () => clickPrevious());
  }

  function reportStatus() {
    const status = buildStatus();
    // Keep Windows+A (System Media Controls) accurate even in PiP/minimized/fullscreen transitions.
    syncWindowsMediaSessionFromStatus(status);
    bindMediaActionHandlers();

    const serialized = JSON.stringify(status);
    const now = Date.now();
    if (serialized === lastReportedStatus && now - lastReportedAt < STATUS_PUSH_MIN_MS) return;
    lastReportedStatus = serialized;
    lastReportedAt = now;

    ext()?.sendMessage({ type: 'STATUS_UPDATE', status });
  }

  function bindWindowsMediaSessionSyncEvents() {
    if (document.documentElement.dataset.ytmMediaSyncBound === '1') return;
    document.documentElement.dataset.ytmMediaSyncBound = '1';

    const resyncSoon = () => {
      const status = buildStatus();
      syncWindowsMediaSessionFromStatus(status);
      setTimeout(() => syncWindowsMediaSessionFromStatus(buildStatus()), 250);
      setTimeout(() => syncWindowsMediaSessionFromStatus(buildStatus()), 900);
    };

    // PiP transitions can confuse Windows media routing. Resync on enter/leave.
    document.addEventListener('enterpictureinpicture', resyncSoon, true);
    document.addEventListener('leavepictureinpicture', resyncSoon, true);

    // When YTM swaps the <video> element, rebind and resync.
    const rebindVideo = () => {
      const status = buildStatus();
      syncWindowsMediaSessionFromStatus(status);
    };

    const videoObserver = new MutationObserver(rebindVideo);
    videoObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  let windowsMediaKeepAliveId = null;
  function startWindowsMediaKeepAlive() {
    if (windowsMediaKeepAliveId) return;
    windowsMediaKeepAliveId = setInterval(() => {
      // Keep SMTC alive even if status didn't change (prevents needing Win+A “kick”).
      syncWindowsMediaSessionFromStatus(buildStatus());
    }, 1800);
  }

  function isValidVideoId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
  }

  function getRealVideoId() {
    const player = getMoviePlayer();
    if (player && typeof player.getVideoData === 'function') {
      try {
        const data = player.getVideoData();
        if (data?.video_id && isValidVideoId(data.video_id)) {
          return data.video_id;
        }
      } catch (_) {
        /* ignore */
      }
    }

    const video = document.querySelector('video');
    if (video?.src) {
      const match = video.src.match(/[?&]v=([^&]+)/);
      if (match && isValidVideoId(match[1])) return match[1];
    }

    const fromUrl = new URLSearchParams(location.search).get('v');
    if (isValidVideoId(fromUrl)) return fromUrl;
    return null;
  }

  function notifyKeepMinimized() {
    ext()?.sendMessage({ type: 'TRACK_ENDED' });
  }

  function onTrackChanged(videoId) {
    const realId = isValidVideoId(videoId) ? videoId : getRealVideoId();
    if (!realId || realId === lastSeenVideoId) return;
    lastSeenVideoId = realId;
    lastAppliedQuality = '';
    lastTargetQuality = '';
    lastUiQualityVideoId = '';
    clearQualityRetries();

    log('Track change:', realId);

    document.dispatchEvent(new CustomEvent('ytm-track-changed'));
    ext()?.sendMessage({ type: 'TRACK_CHANGED' });

    if (window.YtmListenHistory) {
      window.YtmListenHistory.record({
        videoId: realId,
        title: getTrackTitle(),
        artist: getTrackArtist()
      });
    }

    scheduleQualityCheck(PLAYER_READY_DELAY_MS);
    scheduleQualityRetries();
  }

  function clearQualityRetries() {
    qualityRetryTimers.forEach((id) => clearTimeout(id));
    qualityRetryTimers = [];
  }

  function scheduleQualityRetries() {
    clearQualityRetries();
    QUALITY_RETRY_STEPS.forEach((delay) => {
      const id = setTimeout(() => {
        if (!enabled) return;
        maximizePlaybackQuality();
        reportStatus();
      }, delay);
      qualityRetryTimers.push(id);
    });
  }

  function runQualityCheck() {
    if (!enabled) {
      reportStatus();
      return;
    }

    if (!isPlayerReady()) {
      scheduleQualityCheck(PLAYER_READY_DELAY_MS);
      return;
    }

    const currentId = getCurrentVideoId();
    if (currentId && currentId !== lastSeenVideoId) {
      onTrackChanged(currentId);
      return;
    }

    const result = maximizePlaybackQuality();
    reportStatus();

    if (result.target && (result.current !== result.target || needsHigherVideoQuality(result.target))) {
      scheduleQualityRetries();
    }
  }

  function scheduleQualityCheck(delay = DEBOUNCE_MS) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runQualityCheck, delay);
  }

  function onDomChange() {
    if (observerThrottleTimer) return;
    observerThrottleTimer = setTimeout(() => {
      observerThrottleTimer = null;
      scheduleQualityCheck();
    }, OBSERVER_THROTTLE_MS);
  }

  function watchVideoElement() {
    const attach = (video) => {
      if (!video || video.dataset.ytmHqBound) return;
      video.dataset.ytmHqBound = '1';
      video.addEventListener('loadstart', () => {
        notifyKeepMinimized();
        onTrackChanged(getCurrentVideoId());
      });
      video.addEventListener('ended', notifyKeepMinimized);
      video.addEventListener('loadeddata', () => scheduleQualityCheck(PLAYER_READY_DELAY_MS));
      video.addEventListener('loadedmetadata', () => scheduleQualityCheck(500));
      video.addEventListener('resize', () => scheduleQualityCheck());
      video.addEventListener('ratechange', () => scheduleQualityCheck());
    };

    document.querySelectorAll('video').forEach(attach);

    const videoObserver = new MutationObserver(() => {
      document.querySelectorAll('video').forEach(attach);
      if (enabled) onDomChange();
    });
    videoObserver.observe(document.body, { childList: true, subtree: true });
  }

  function attachObservers() {
    const playerBar = document.querySelector(SELECTORS.playerBar);
    const observeTarget = playerBar || document.body;

    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((m) => {
        const target = m.target;
        if (!(target instanceof Element)) return false;
        if (target.closest && target.closest(SELECTORS.playerBar)) return true;
        if (target.closest && target.closest(SELECTORS.moviePlayer)) return true;
        return false;
      });
      if (relevant) onDomChange();
    });

    observer.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'playback-mode']
    });

    document.addEventListener('yt-navigate-finish', () => {
      notifyKeepMinimized();
      lastSeenVideoId = '';
      scheduleQualityCheck(PLAYER_READY_DELAY_MS);
    });

    document.addEventListener('yt-page-data-updated', () => {
      scheduleQualityCheck(PLAYER_READY_DELAY_MS);
    });
  }

  function bindPlayerQualityEvents() {
    const player = getMoviePlayer();
    if (!player || player.dataset.ytmHqEvents) return;
    player.dataset.ytmHqEvents = '1';

    if (typeof player.addEventListener === 'function') {
      player.addEventListener('onPlaybackQualityChange', () => {
        if (enabled) scheduleQualityCheck();
      });
    }
  }

  ext()?.onMessage((message, _sender, sendResponse) => {
    if (message.type === 'GET_STATUS') {
      sendResponse(buildStatus());
      return true;
    }

    if (message.type === 'SET_ENABLED') {
      enabled = Boolean(message.enabled);
      ext()?.storageSet({ [STORAGE_KEY]: enabled }, () => {
        if (enabled) {
          lastSeenVideoId = '';
          scheduleQualityCheck(PLAYER_READY_DELAY_MS);
        }
        reportStatus();
        sendResponse({ ok: true, enabled });
      });
      return true;
    }

    return false;
  });

  function loadEnabledState(callback) {
    if (!ext()?.isContextValid()) {
      enabled = true;
      callback();
      return;
    }
    ext().storageGet([STORAGE_KEY, LEGACY_STORAGE_KEY], (result) => {
      if (result[STORAGE_KEY] !== undefined) {
        enabled = result[STORAGE_KEY] !== false;
      } else if (result[LEGACY_STORAGE_KEY] !== undefined) {
        enabled = result[LEGACY_STORAGE_KEY] !== false;
        ext().storageSet({ [STORAGE_KEY]: enabled });
      } else {
        enabled = true;
      }
      callback();
    });
  }

  function init() {
    if (!ext()?.isContextValid()) return;

    installStorageQualityGuard();
    bindWindowsMediaSessionSyncEvents();
    startWindowsMediaKeepAlive();
    bindMediaActionHandlers();

    const pauseOnLeave = () => {
      const video = document.querySelector('video');
      if (video && !video.paused) {
        try {
          video.pause();
        } catch (_) {
          /* ignore */
        }
      }
    };

    window.addEventListener('beforeunload', pauseOnLeave);
    window.addEventListener('pagehide', pauseOnLeave);

    loadEnabledState(() => {
      attachObservers();
      watchVideoElement();
      bindPlayerQualityEvents();
      scheduleQualityCheck(PLAYER_READY_DELAY_MS);
      reportStatus();
      log('Initialized, high quality mode:', enabled ? 'enabled' : 'disabled');
    });

    ext().onStorageChanged((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      enabled = changes[STORAGE_KEY].newValue !== false;
      if (enabled) {
        lastSeenVideoId = '';
        scheduleQualityCheck(PLAYER_READY_DELAY_MS);
      }
      reportStatus();
    });

    bindPlayerIntervalId = setInterval(() => {
      if (!ext()?.isContextValid()) {
        if (bindPlayerIntervalId) clearInterval(bindPlayerIntervalId);
        return;
      }
      bindPlayerQualityEvents();
    }, 5000);

    ext().onInvalidated(() => {
      if (bindPlayerIntervalId) clearInterval(bindPlayerIntervalId);
      bindPlayerIntervalId = null;
      clearQualityRetries();
      clearTimeout(debounceTimer);
      clearTimeout(observerThrottleTimer);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
