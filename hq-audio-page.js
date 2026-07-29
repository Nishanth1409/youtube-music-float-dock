/**
 * MAIN-world forced HQ helper for YouTube Music.
 * Strict playback ladder:
 * video 8K → 4K → 2K (1440p) → 1080p, never below 1080p;
 * audio 350 kbps → 250 kbps → 128 kbps only, with no network downgrade.
 */
(function () {
  'use strict';

  if (window.__ytmHqAudioInstalled) return;
  window.__ytmHqAudioInstalled = true;

  const AUDIO_HIGH = 'AUDIO_QUALITY_HIGH';
  // Encoders report small bitrate variations, so each nominal rung has a
  // narrow acceptance range. Intermediate qualities remain excluded.
  const AUDIO_TIERS = [
    { kbps: 350, minBps: 315000, maxBps: 385000 },
    { kbps: 250, minBps: 225000, maxBps: 275000 },
    { kbps: 128, minBps: 120000, maxBps: 136000 }
  ];
  const TARGET_AUDIO_KBPS = 350;
  const VIDEO_TIERS = [4320, 2160, 1440, 1080];
  const PREFERRED_AUDIO_ITAGS = new Set([774, 141, 251, 140]);
  const LOG_PREFIX = '[YTM Float HQ Force]';
  let enabled = false;
  let applyTimer = null;
  let lockIntervalId = null;
  let lastReportedBitrateKbps = 0;
  let lastForcedVideoHeight = 0;

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
    let score = 0;
    if (PREFERRED_AUDIO_ITAGS.has(itag)) score += 100_000 - itag;
    const mime = String(fmt.mimeType || '');
    if (/opus/i.test(mime)) score += 5_000;
    if (/mp4a\.40\.2/i.test(mime)) score += 4_000;
    return score;
  }

  function selectAudioTier(audioFormats) {
    for (const tier of AUDIO_TIERS) {
      const atTier = audioFormats.filter((fmt) => {
        const bps = audioBitrateBps(fmt);
        return bps >= tier.minBps && bps <= tier.maxBps;
      });
      if (atTier.length === 0) continue;

      const targetBps = tier.kbps * 1000;
      atTier.sort((a, b) => {
        const distanceA = Math.abs(audioBitrateBps(a) - targetBps);
        const distanceB = Math.abs(audioBitrateBps(b) - targetBps);
        return distanceA - distanceB ||
          audioFormatTieBreakScore(b) - audioFormatTieBreakScore(a);
      });
      return { tier: tier.kbps, format: atTier[0] };
    }
    return { tier: 0, format: null };
  }

  function scoreVideoFormat(fmt) {
    const h = Number(fmt.height || 0);
    const w = Number(fmt.width || 0);
    const br = Number(fmt.averageBitrate || fmt.bitrate || 0);
    const fps = Number(fmt.fps || 0);
    // Height dominates; then bitrate/fps so we keep the best encode at that height.
    return h * 1_000_000 + w * 100 + br + fps * 10;
  }

  function selectVideoTier(videoFormats) {
    for (const tier of VIDEO_TIERS) {
      const atTier = videoFormats.filter((fmt) => Number(fmt.height || 0) === tier);
      if (atTier.length > 0) {
        atTier.sort((a, b) => scoreVideoFormat(b) - scoreVideoFormat(a));
        return { tier, formats: atTier };
      }
    }
    return { tier: 0, formats: [] };
  }

  function forceHighestFormats(streaming) {
    if (!streaming || typeof streaming !== 'object') return;

    const forceList = (listName) => {
      const list = streaming[listName];
      if (!Array.isArray(list) || list.length === 0) return;

      // Progressive formats contain inseparable audio/video and can let the
      // player bypass the exact adaptive quality rung selected below.
      if (listName === 'formats') {
        streaming[listName] = [];
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

      const selectedVideo = selectVideoTier(
        videoLike.filter((fmt) => {
          const height = Number(fmt.height || 0);
          return VIDEO_TIERS.includes(height);
        })
      );
      const keptVideo = selectedVideo.formats;
      lastForcedVideoHeight = selectedVideo.tier;

      const selectedAudio = selectAudioTier(audioLike);
      let keptAudio = [];
      if (selectedAudio.format) {
        // Keep one stream from the highest available exact rung. Removing all
        // lower rungs prevents ABR from reducing audio on a slow connection.
        keptAudio = [selectedAudio.format];
        const bestBps = audioBitrateBps(selectedAudio.format);
        lastReportedBitrateKbps = Math.round(bestBps / 1000);
      } else {
        lastReportedBitrateKbps = 0;
      }

      streaming[listName] = keptVideo.concat(keptAudio);
      log(
        `Strict ${listName}: video=${keptVideo.length}@${lastForcedVideoHeight || 'blocked'}p audio=${keptAudio.length}` +
          (lastReportedBitrateKbps ? `~${lastReportedBitrateKbps}kbps` : '')
      );

      try {
        window.postMessage(
          {
            source: 'ytm-float-dock-page',
            type: 'HQ_AUDIO_STATUS',
            targetKbps: TARGET_AUDIO_KBPS,
            selectedKbps: lastReportedBitrateKbps || null,
            forcedVideoHeight: lastForcedVideoHeight || null
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

  function preferHighestInPlayerResponse(response) {
    if (!response || typeof response !== 'object') return response;
    try {
      if (response.streamingData) forceHighestFormats(response.streamingData);
      if (response.response && response.response.streamingData) {
        forceHighestFormats(response.response.streamingData);
      }
      // Some payloads nest playerResponse
      if (response.playerResponse && response.playerResponse.streamingData) {
        forceHighestFormats(response.playerResponse.streamingData);
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
          if (!enabled) return response;
          const url = typeof input === 'string' ? input : input && input.url;
          if (!url || (url.indexOf('/player') === -1 && url.indexOf('/youtubei/') === -1)) {
            return response;
          }
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
          forcedVideoHeight: lastForcedVideoHeight || null
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
