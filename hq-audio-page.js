/**
 * MAIN-world forced HQ helper for YouTube Music.
 * Strict playback ladder:
 * video 8K → 4K → 2K (1440p) → 1080p, never below 1080p;
 * audio prefers YouTube's AUDIO_QUALITY_HIGH when offered, else best available;
 * nominal ladder 350 → 250 → 128 kbps, with no network downgrade.
 */
(function () {
  'use strict';

  if (window.__ytmHqAudioInstalled) return;
  window.__ytmHqAudioInstalled = true;

  const AUDIO_HIGH = 'AUDIO_QUALITY_HIGH';
  // Nominal display ladder. Selection itself prefers YouTube's audioQuality
  // label (HIGH → MEDIUM → LOW), then bitrate / known high itags.
  const AUDIO_TIERS = [
    { kbps: 350, minBps: 300000, maxBps: 400000 },
    { kbps: 250, minBps: 220000, maxBps: 299999 },
    { kbps: 128, minBps: 110000, maxBps: 170000 }
  ];
  const TARGET_AUDIO_KBPS = 350;
  const VIDEO_TIERS = [4320, 2160, 1440, 1080];
  // Premium high: 141 (AAC ~256), 774 (Opus ~256). Default web: 140 (~128 AAC), 251 (~128–160 Opus).
  const PREFERRED_AUDIO_ITAGS = new Set([774, 141, 251, 140]);
  const HIGH_AUDIO_ITAGS = new Set([774, 141, 256, 258]);
  const AUDIO_QUALITY_RANK = {
    AUDIO_QUALITY_HIGH: 3,
    AUDIO_QUALITY_MEDIUM: 2,
    AUDIO_QUALITY_LOW: 1
  };
  const LOG_PREFIX = '[YTM Float HQ Force]';
  let enabled = false;
  let applyTimer = null;
  let lockIntervalId = null;
  let lastReportedBitrateKbps = 0;
  let lastForcedVideoHeight = 0;
  let lastStatusVideoId = '';
  // The first /player request can beat the settings lookup on a fresh window.
  let enabledStateKnown = false;
  const enabledStateWaiters = [];
  const ENABLED_STATE_WAIT_MS = 1200;

  function markEnabledStateKnown() {
    if (enabledStateKnown) return;
    enabledStateKnown = true;
    while (enabledStateWaiters.length) {
      enabledStateWaiters.shift()();
    }
  }

  function waitForEnabledState() {
    if (enabledStateKnown) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, ENABLED_STATE_WAIT_MS);
      enabledStateWaiters.push(finish);
    });
  }

  function log(...args) {
    if (typeof console !== 'undefined' && console.debug) {
      console.debug(LOG_PREFIX, ...args);
    }
  }

  function spoofFastConnection() {
    try {
      const fake = {
        downlink: 100,
        downlinkMax: 100,
        effectiveType: '4g',
        rtt: 20,
        saveData: false,
        type: 'wifi',
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
        onchange: null
      };
      try {
        Object.defineProperty(navigator, 'connection', {
          configurable: true,
          get() {
            return fake;
          }
        });
      } catch (_) {
        /* ignore */
      }
      try {
        Object.defineProperty(navigator, 'mozConnection', {
          configurable: true,
          get() {
            return fake;
          }
        });
      } catch (_) {
        /* ignore */
      }
      try {
        Object.defineProperty(navigator, 'webkitConnection', {
          configurable: true,
          get() {
            return fake;
          }
        });
      } catch (_) {
        /* ignore */
      }
    } catch (_) {
      /* ignore */
    }
  }

  function setYtcfgForcedHigh() {
    try {
      const cfg = window.ytcfg;
      if (!cfg) return false;
      if (typeof cfg.set === 'function') {
        cfg.set('AUDIO_QUALITY', AUDIO_HIGH);
        // Hint high bandwidth / disable data-saving style paths when present.
        try {
          cfg.set('HTML5_PLAYER_ABR_BANDWIDTH_ESTIMATION_OVERRIDE', 100000000);
        } catch (_) {
          /* ignore */
        }
      }
      if (cfg.data_ && typeof cfg.data_ === 'object') {
        cfg.data_.AUDIO_QUALITY = AUDIO_HIGH;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function audioBitrateBps(fmt) {
    return Number(fmt.averageBitrate || fmt.bitrate || 0);
  }

  function isAudioFormat(fmt) {
    const mime = String(fmt.mimeType || '');
    return (
      /audio\//i.test(mime) ||
      (!fmt.width && !fmt.height && (fmt.bitrate || fmt.averageBitrate || fmt.audioSampleRate))
    );
  }

  function isVideoFormat(fmt) {
    return Boolean(fmt && (fmt.width || fmt.height || /video\//i.test(String(fmt.mimeType || ''))));
  }

  function audioFormatTieBreakScore(fmt) {
    const itag = Number(fmt.itag || 0);
    let score = audioBitrateBps(fmt);
    if (HIGH_AUDIO_ITAGS.has(itag)) score += 2_000_000;
    if (PREFERRED_AUDIO_ITAGS.has(itag)) score += 100_000 - itag;
    const mime = String(fmt.mimeType || '');
    if (/opus/i.test(mime)) score += 5_000;
    if (/mp4a\.40\.2/i.test(mime)) score += 4_000;
    return score;
  }

  /** YouTube's own audio rung — same idea as qualityLabel for video. */
  function audioQualityRank(fmt) {
    const label = String(fmt.audioQuality || '').toUpperCase();
    if (AUDIO_QUALITY_RANK[label]) return AUDIO_QUALITY_RANK[label];
    const itag = Number(fmt.itag || 0);
    if (HIGH_AUDIO_ITAGS.has(itag)) return AUDIO_QUALITY_RANK.AUDIO_QUALITY_HIGH;
    const bps = audioBitrateBps(fmt);
    if (bps >= 220000) return AUDIO_QUALITY_RANK.AUDIO_QUALITY_HIGH;
    if (bps >= 110000) return AUDIO_QUALITY_RANK.AUDIO_QUALITY_MEDIUM;
    if (bps > 0) return AUDIO_QUALITY_RANK.AUDIO_QUALITY_LOW;
    return 0;
  }

  function nominalAudioKbps(fmt) {
    const bps = audioBitrateBps(fmt);
    if (bps > 0) {
      for (const tier of AUDIO_TIERS) {
        if (bps >= tier.minBps && bps <= tier.maxBps) return tier.kbps;
      }
      return Math.round(bps / 1000);
    }
    const itag = Number(fmt.itag || 0);
    if (HIGH_AUDIO_ITAGS.has(itag)) return 250;
    if (itag === 140 || itag === 251) return 128;
    return 0;
  }

  function selectAudioTier(audioFormats) {
    if (!audioFormats.length) return { tier: 0, format: null };

    // Label-first, like video: keep only the highest audioQuality YouTube offers.
    let bestRank = 0;
    for (const fmt of audioFormats) {
      bestRank = Math.max(bestRank, audioQualityRank(fmt));
    }
    const atBest =
      bestRank > 0
        ? audioFormats.filter((fmt) => audioQualityRank(fmt) === bestRank)
        : audioFormats.slice();

    atBest.sort((a, b) => audioFormatTieBreakScore(b) - audioFormatTieBreakScore(a));
    const format = atBest[0];
    return { tier: nominalAudioKbps(format), format };
  }

  function scoreVideoFormat(fmt) {
    const h = Number(fmt.height || 0);
    const w = Number(fmt.width || 0);
    const br = Number(fmt.averageBitrate || fmt.bitrate || 0);
    const fps = Number(fmt.fps || 0);
    // Height dominates; then bitrate/fps so we keep the best encode at that height.
    return h * 1_000_000 + w * 100 + br + fps * 10;
  }

  /**
   * YouTube's ladder rung for a format. Pixel height alone is wrong for
   * anything that is not 16:9 — an ultrawide 4K stream is 3840x1608, and a
   * vertical one is taller than its rung. qualityLabel is YouTube's own rung.
   */
  function formatLadderHeight(fmt) {
    const label = String(fmt.qualityLabel || '').match(/^(\d{3,5})p/i);
    if (label) return Number(label[1]);

    const quality = String(fmt.quality || '').match(/^hd(\d{3,5})$/i);
    if (quality) return Number(quality[1]);

    const width = Number(fmt.width || 0);
    const height = Number(fmt.height || 0);
    // Short side approximates the rung for both ultrawide and vertical video.
    if (width && height) return Math.min(width, height);
    return height;
  }

  /** Nearest supported rung, tolerating encodes like 1088p that mean 1080p. */
  function formatTier(fmt) {
    const ladderHeight = formatLadderHeight(fmt);
    if (!ladderHeight) return 0;
    return VIDEO_TIERS.find((tier) => ladderHeight >= tier * 0.95) || 0;
  }

  function selectVideoTier(videoFormats) {
    for (const tier of VIDEO_TIERS) {
      const atTier = videoFormats.filter((fmt) => formatTier(fmt) === tier);
      if (atTier.length > 0) {
        atTier.sort((a, b) => scoreVideoFormat(b) - scoreVideoFormat(a));
        return { tier, formats: atTier };
      }
    }
    return { tier: 0, formats: [] };
  }

  function forceHighestFormats(streaming, videoId) {
    if (!streaming || typeof streaming !== 'object') return;
    if (videoId) lastStatusVideoId = videoId;

    let adaptiveLocked = false;

    const forceList = (listName) => {
      const list = streaming[listName];
      if (!Array.isArray(list) || list.length === 0) return;

      // Progressive formats are muxed and let the player sidestep the adaptive
      // rung, but dropping them is only safe once adaptive selection worked.
      if (listName === 'formats') {
        if (adaptiveLocked) streaming[listName] = [];
        return;
      }

      const videoLike = [];
      const audioLike = [];
      const other = [];

      for (const fmt of list) {
        if (isAudioFormat(fmt) && !isVideoFormat(fmt)) audioLike.push(fmt);
        else if (isVideoFormat(fmt)) videoLike.push(fmt);
        else other.push(fmt);
      }

      const selectedVideo = selectVideoTier(videoLike);
      lastForcedVideoHeight = selectedVideo.tier;
      // Falling back to the untouched list keeps playback alive when a track
      // offers nothing at a supported rung.
      const keptVideo = selectedVideo.formats.length > 0 ? selectedVideo.formats : videoLike;

      const selectedAudio = selectAudioTier(audioLike);
      let keptAudio = [];
      if (selectedAudio.format) {
        // Keep only the highest audioQuality YouTube offered. Removing lower
        // rungs prevents ABR from dropping to the default ~128 kbps stream.
        keptAudio = [selectedAudio.format];
        const bestBps = audioBitrateBps(selectedAudio.format);
        lastReportedBitrateKbps =
          bestBps > 0 ? Math.round(bestBps / 1000) : selectedAudio.tier;
      } else {
        keptAudio = audioLike;
        lastReportedBitrateKbps = 0;
      }

      adaptiveLocked = selectedVideo.formats.length > 0 && Boolean(selectedAudio.format);

      streaming[listName] = keptVideo.concat(keptAudio);
      log(
        `Strict ${listName}: video=${keptVideo.length}@${lastForcedVideoHeight || 'unchanged'}p audio=${keptAudio.length}` +
          (lastReportedBitrateKbps ? `~${lastReportedBitrateKbps}kbps` : '')
      );

      try {
        window.postMessage(
          {
            source: 'ytm-float-dock-page',
            type: 'HQ_AUDIO_STATUS',
            targetKbps: TARGET_AUDIO_KBPS,
            selectedKbps: lastReportedBitrateKbps || null,
            forcedVideoHeight: lastForcedVideoHeight || null,
            videoId: lastStatusVideoId || null
          },
          '*'
        );
      } catch (_) {
        /* ignore */
      }
    };

    forceList('adaptiveFormats');
    forceList('formats');
  }

  function playerResponseVideoId(response) {
    return (
      response?.videoDetails?.videoId ||
      response?.response?.videoDetails?.videoId ||
      response?.playerResponse?.videoDetails?.videoId ||
      ''
    );
  }

  function preferHighestInPlayerResponse(response) {
    if (!response || typeof response !== 'object') return response;
    try {
      // The popup pairs the reported quality with this id so it survives a
      // track-change reset that lands after the /player response.
      const videoId = playerResponseVideoId(response);
      if (response.streamingData) forceHighestFormats(response.streamingData, videoId);
      if (response.response && response.response.streamingData) {
        forceHighestFormats(response.response.streamingData, videoId);
      }
      // Some payloads nest playerResponse
      if (response.playerResponse && response.playerResponse.streamingData) {
        forceHighestFormats(response.playerResponse.streamingData, videoId);
      }
    } catch (_) {
      /* ignore */
    }
    return response;
  }

  function patchPlayerJsonPayload(text) {
    if (!enabled || typeof text !== 'string' || text.length < 20) return text;
    if (text.indexOf('adaptiveFormats') === -1 && text.indexOf('streamingData') === -1) {
      return text;
    }
    try {
      const data = JSON.parse(text);
      preferHighestInPlayerResponse(data);
      return JSON.stringify(data);
    } catch (_) {
      return text;
    }
  }

  function installNetworkHooks() {
    if (window.__ytmHqAudioNetHooks) return;
    window.__ytmHqAudioNetHooks = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = async function ytmHqFetch(input, init) {
        const response = await originalFetch.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : input && input.url;
          if (!url || (url.indexOf('/player') === -1 && url.indexOf('/youtubei/') === -1)) {
            return response;
          }
          // Hold only the first /player long enough to learn the setting,
          // otherwise the opening song is never forced or reported.
          if (!enabledStateKnown && url.indexOf('/player') !== -1) {
            await waitForEnabledState();
          }
          if (!enabled) return response;
          const clone = response.clone();
          const text = await clone.text();
          const patched = patchPlayerJsonPayload(text);
          if (patched === text) return response;
          return new Response(patched, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        } catch (_) {
          return response;
        }
      };
    }

    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ytmHqUrl = url;
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (enabled) {
        this.addEventListener('load', function () {
          try {
            const u = String(this.__ytmHqUrl || '');
            if (u.indexOf('/player') === -1 && u.indexOf('/youtubei/') === -1) return;
            if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return;
            const raw = this.responseText;
            const patched = patchPlayerJsonPayload(raw);
            if (patched !== raw) {
              Object.defineProperty(this, 'responseText', { get: () => patched });
              Object.defineProperty(this, 'response', { get: () => patched });
            }
          } catch (_) {
            /* ignore */
          }
        });
      }
      return XS.apply(this, arguments);
    };
  }

  function forcePlayerApiHigh() {
    try {
      const player =
        document.getElementById('movie_player') || document.querySelector('#movie_player');
      if (!player) return;

      const rank = {
        hd4320: 4320,
        highres: 4320,
        hd2160: 2160,
        hd1440: 1440,
        hd1080: 1080
      };
      let maxQ = null;
      if (typeof player.getAvailableQualityLevels === 'function') {
        const levels = (player.getAvailableQualityLevels() || []).filter(
          (q) => q && q !== 'auto' && q !== 'unknown'
        );
        for (const tier of VIDEO_TIERS) {
          maxQ = levels.find((level) => rank[level] === tier);
          if (maxQ) break;
        }
      }
      if (!maxQ && typeof player.getMaxPlaybackQuality === 'function') {
        const reportedMax = player.getMaxPlaybackQuality();
        if (rank[reportedMax]) maxQ = reportedMax;
      }
      const allowedPlayerQuality = new Set([
        'hd4320',
        'highres',
        'hd2160',
        'hd1440',
        'hd1080'
      ]);
      if (!maxQ || maxQ === 'unknown' || !allowedPlayerQuality.has(maxQ)) return;

      if (typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(maxQ, maxQ);
      }
      if (typeof player.setPlaybackQuality === 'function') {
        const cur =
          typeof player.getPlaybackQuality === 'function' ? player.getPlaybackQuality() : null;
        if (cur !== maxQ) player.setPlaybackQuality(maxQ);
      }

      if (typeof player.getAvailableAudioTracks === 'function' && typeof player.setAudioTrack === 'function') {
        const tracks = player.getAvailableAudioTracks() || [];
        if (tracks.length > 1) {
          let best = tracks[0];
          let bestScore = -1;
          for (const track of tracks) {
            const label = String(track?.displayName || track?.name || track?.id || '');
            const score =
              (/350|320|high|hi-?res|premium|250|256|opus/i.test(label) ? 100 : 0) +
              (/original|default/i.test(label) ? 10 : 0);
            if (score > bestScore) {
              bestScore = score;
              best = track;
            }
          }
          player.setAudioTrack(best);
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  function applyForcedHigh() {
    if (!enabled) return;
    spoofFastConnection();
    const ok = setYtcfgForcedHigh();
    if (ok) log('Forced HIGH audio + spoofed fast connection');
    forcePlayerApiHigh();

    try {
      window.postMessage(
        {
          source: 'ytm-float-dock-page',
          type: 'HQ_AUDIO_STATUS',
          targetKbps: TARGET_AUDIO_KBPS,
          selectedKbps: lastReportedBitrateKbps || null,
          forcedVideoHeight: lastForcedVideoHeight || null,
          videoId: lastStatusVideoId || null
        },
        '*'
      );
    } catch (_) {
      /* ignore */
    }
  }

  function scheduleApply() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(applyForcedHigh, 150);
  }

  function startLockLoop() {
    if (lockIntervalId) return;
    lockIntervalId = setInterval(() => {
      if (!enabled) return;
      forcePlayerApiHigh();
    }, 2000);
  }

  function stopLockLoop() {
    if (lockIntervalId) {
      clearInterval(lockIntervalId);
      lockIntervalId = null;
    }
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    markEnabledStateKnown();
    if (enabled) {
      spoofFastConnection();
      installNetworkHooks();
      scheduleApply();
      startLockLoop();
    } else {
      stopLockLoop();
    }
    log('enabled =', enabled);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'ytm-float-dock') return;
    if (data.type === 'HQ_AUDIO_SET') {
      setEnabled(data.enabled);
    } else if (data.type === 'HQ_AUDIO_APPLY') {
      if (enabled) scheduleApply();
    }
  });

  installNetworkHooks();
  spoofFastConnection();
})();
