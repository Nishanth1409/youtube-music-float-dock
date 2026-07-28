/**
 * Listen history + one-tap random play (button only — no auto-skip loops).
 */
(function () {
  'use strict';

  const HISTORY_KEY = 'listenHistory';
  const SESSION_PICKS_KEY = 'ytm-random-session-picks';
  const MAX_HISTORY = 5000;
  const SESSION_EXCLUDE_COUNT = 8;
  const LOG_PREFIX = '[YTM Float]';

  const MS = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000
  };

  const ext = () => window.YtmExtension;

  function log(...args) {
    console.debug(LOG_PREFIX, ...args);
  }

  function isValidVideoId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
  }

  function normalizeTrack(track) {
    const playedAt = track.lastPlayedAt || track.playedAt || track.firstPlayedAt || Date.now();
    return {
      videoId: track.videoId,
      title: (track.title || '').trim(),
      artist: (track.artist || '').trim(),
      firstPlayedAt: track.firstPlayedAt || playedAt,
      lastPlayedAt: playedAt,
      playCount: track.playCount || 1
    };
  }

  function getHistory(callback) {
    if (!ext()?.isContextValid()) {
      callback([]);
      return;
    }
    ext().storageGet([HISTORY_KEY], (result) => {
      const raw = Array.isArray(result[HISTORY_KEY]) ? result[HISTORY_KEY] : [];
      callback(raw.map(normalizeTrack));
    });
  }

  function saveHistory(history, callback) {
    if (!ext()?.isContextValid()) return;
    ext().storageSet({ [HISTORY_KEY]: history.slice(0, MAX_HISTORY) }, callback);
  }

  function getSessionPicks() {
    try {
      const raw = sessionStorage.getItem(SESSION_PICKS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function rememberSessionPick(videoId) {
    const picks = getSessionPicks().filter((id) => id !== videoId);
    picks.unshift(videoId);
    sessionStorage.setItem(SESSION_PICKS_KEY, JSON.stringify(picks.slice(0, SESSION_EXCLUDE_COUNT)));
  }

  function record(track) {
    if (!track || !isValidVideoId(track.videoId)) return;

    getHistory((history) => {
      const now = Date.now();
      const existing = history.find((item) => item.videoId === track.videoId);

      let next;
      if (existing) {
        next = history.filter((item) => item.videoId !== track.videoId);
        next.push(
          normalizeTrack({
            ...existing,
            title: track.title || existing.title,
            artist: track.artist || existing.artist,
            lastPlayedAt: now,
            playCount: (existing.playCount || 1) + 1
          })
        );
      } else {
        next = [
          ...history,
          normalizeTrack({
            videoId: track.videoId,
            title: track.title,
            artist: track.artist,
            firstPlayedAt: now,
            lastPlayedAt: now,
            playCount: 1
          })
        ];
      }

      next.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
      saveHistory(next, () => log('Recorded:', track.title || track.videoId));
    });
  }

  function trackAgeMs(track, now) {
    return Math.max(0, now - (track.lastPlayedAt || track.firstPlayedAt || now));
  }

  function pickWeightedByPlays(tracks) {
    if (!tracks.length) return null;
    const weights = tracks.map((t) => Math.sqrt(t.playCount || 1));
    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = Math.random() * total;

    for (let i = 0; i < tracks.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return tracks[i];
    }

    return tracks[tracks.length - 1];
  }

  function pickFromAgeBuckets(pool, now) {
    const buckets = [
      {
        name: 'week',
        tracks: pool.filter((t) => trackAgeMs(t, now) < MS.week)
      },
      {
        name: 'month',
        tracks: pool.filter((t) => {
          const age = trackAgeMs(t, now);
          return age >= MS.week && age < MS.month;
        })
      },
      {
        name: 'year',
        tracks: pool.filter((t) => {
          const age = trackAgeMs(t, now);
          return age >= MS.month && age < MS.year;
        })
      },
      {
        name: 'older',
        tracks: pool.filter((t) => trackAgeMs(t, now) >= MS.year)
      }
    ];

    const available = buckets.filter((b) => b.tracks.length);
    if (!available.length) return null;

    const bucket = available[Math.floor(Math.random() * available.length)];
    return pickWeightedByPlays(bucket.tracks);
  }

  function pickRandomTrack(history, excludeIds) {
    const currentId = new URLSearchParams(location.search).get('v');
    const blocked = new Set(excludeIds);
    if (currentId) blocked.add(currentId);

    const pool = history.filter((t) => isValidVideoId(t.videoId) && !blocked.has(t.videoId));
    if (!pool.length) {
      const fallback = history.filter((t) => isValidVideoId(t.videoId) && t.videoId !== currentId);
      if (!fallback.length) return null;
      return pickWeightedByPlays(fallback);
    }

    const now = Date.now();

    // 35%: deep catalog — any song, equal chance (surfaces month/year+ old listens)
    if (Math.random() < 0.35) {
      return pool[Math.floor(Math.random() * pool.length)];
    }

    // 65%: pick a time bucket first (week / month / year / older), then by play count
    const fromBucket = pickFromAgeBuckets(pool, now);
    if (fromBucket) return fromBucket;

    return pool[Math.floor(Math.random() * pool.length)];
  }

  function playTrackOnce(track) {
    const target = `https://music.youtube.com/watch?v=${track.videoId}`;
    const current = new URLSearchParams(location.search);
    if (current.get('v') === track.videoId && !current.get('list')?.startsWith('RD')) {
      return false;
    }
    location.assign(target);
    return true;
  }

  function playRandom(callback) {
    getHistory((history) => {
      if (!history.length) {
        if (callback) callback({ ok: false, reason: 'no_history' });
        return;
      }

      const exclude = new Set(getSessionPicks());
      const picked = pickRandomTrack(history, exclude);

      if (!picked) {
        if (callback) callback({ ok: false, reason: 'no_pick' });
        return;
      }

      rememberSessionPick(picked.videoId);
      const navigated = playTrackOnce(picked);

      if (callback) {
        callback({
          ok: true,
          navigated,
          track: picked
        });
      }

      log('Random play:', picked.title || picked.videoId, '· last played',
        Math.floor(trackAgeMs(picked, Date.now()) / MS.day) + 'd ago');
    });
  }

  window.YtmListenHistory = {
    record,
    getHistory,
    playRandom,
    isValidVideoId
  };
})();
