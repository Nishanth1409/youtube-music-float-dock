/**
 * Always expand YouTube Music Now Playing view (in-page only — no browser fullscreen API).
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'alwaysFullscreenEnabled';
  const EXT_VERSION = '1.7.6';
  const LOG_PREFIX = '[YTM Fullscreen]';
  const HTML_ATTR = 'data-ytm-always-fs';
  const ENFORCE_COOLDOWN_MS = 1500;
  const TARGET_STATE = 'PLAYER_PAGE_OPEN';

  const SELECTORS = {
    appLayout: 'ytmusic-app-layout',
    expandButton: [
      'ytmusic-player-bar .toggle-player-page-button',
      '.toggle-player-page-button.ytmusic-player-bar'
    ],
    minimizeButton: [
      'ytmusic-player-page .player-minimize-button',
      '.player-minimize-button'
    ],
    closeButton: [
      'ytmusic-player-page [aria-label="Close"]',
      'ytmusic-nav-bar #back-button',
      'ytmusic-nav-bar .back-button'
    ]
  };

  let enabled = true;
  let lastEnforceAt = 0;
  let enforceIntervalId = null;
  let stateObserver = null;

  const ext = () => window.YtmExtension;

  function log(...args) {
    console.debug(LOG_PREFIX, ...args);
  }

  function queryFirst(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of list) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function getLayout() {
    return document.querySelector(SELECTORS.appLayout);
  }

  function getPlayerUiState() {
    return getLayout()?.getAttribute('player-ui-state') || '';
  }

  function isExpandedState(state) {
    return state === TARGET_STATE;
  }

  function isPlaying() {
    const video = document.querySelector('video');
    if (video && !video.paused && video.currentTime > 0) return true;

    const player = document.getElementById('movie_player');
    if (player && typeof player.getPlayerState === 'function') {
      try {
        return player.getPlayerState() === 1;
      } catch (_) {
        return false;
      }
    }

    return Boolean(document.querySelector('ytmusic-player-bar [aria-label="Pause"]'));
  }

  function setAlwaysFullscreenAttr(on) {
    const next = on ? 'true' : null;
    const current = document.documentElement.getAttribute(HTML_ATTR);
    if (on && current === 'true') return;
    if (!on && current === null) return;
    if (on) {
      document.documentElement.setAttribute(HTML_ATTR, 'true');
    } else {
      document.documentElement.removeAttribute(HTML_ATTR);
    }
  }

  function exitBrowserFullscreen() {
    if (!document.fullscreenElement) return;
    const exit =
      document.exitFullscreen?.bind(document) ||
      document.webkitExitFullscreen?.bind(document);
    if (exit) exit().catch(() => {});
  }

  function setPlayerUiState(layout, state) {
    if (!layout || layout.getAttribute('player-ui-state') === state) return;
    layout.setAttribute('player-ui-state', state);
  }

  /** Downgrade browser fullscreen state without calling requestFullscreen. */
  function preventBrowserFullscreen(layout) {
    if (!layout) return;
    const state = layout.getAttribute('player-ui-state');
    if (state === 'FULLSCREEN') {
      setPlayerUiState(layout, TARGET_STATE);
      exitBrowserFullscreen();
    }
  }

  /**
   * @param {boolean} userInitiated - true when triggered by a user click on the dock
   */
  function expandPlayerPage(userInitiated = false) {
    const layout = getLayout();
    if (!layout) return false;

    preventBrowserFullscreen(layout);

    const state = getPlayerUiState();
    if (state === TARGET_STATE) return true;

    if (userInitiated) {
      const expandBtn = queryFirst(SELECTORS.expandButton);
      if (expandBtn) {
        expandBtn.click();
        log('Expanded Now Playing view (user click)');
        return true;
      }
    }

    setPlayerUiState(layout, TARGET_STATE);
    log('Expanded Now Playing view');
    return true;
  }

  function isPanelVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
  }

  /** Hides the irritating song-media-window overlay that YTM keeps reopening. */
  function suppressSongMediaWindow() {
    const panel = document.getElementById('song-media-window');
    if (!panel) return;

    panel.style.setProperty('display', 'none', 'important');
    panel.style.setProperty('visibility', 'hidden', 'important');
    panel.style.setProperty('pointer-events', 'none', 'important');
    panel.setAttribute('aria-hidden', 'true');

    const topRow = panel.querySelector('.top-row-buttons');
    if (topRow) {
      topRow.style.setProperty('display', 'none', 'important');
    }
  }

  function attachSongMediaSuppressor() {
    if (document.documentElement.dataset.ytmMediaSuppressBound) return;
    document.documentElement.dataset.ytmMediaSuppressBound = '1';

    const run = () => {
      suppressSongMediaWindow();
    };

    run();

    new MutationObserver(() => {
      const panel = document.getElementById('song-media-window');
      if (panel && isPanelVisible(panel)) run();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'open']
    });

    document.addEventListener('yt-navigate-finish', () => setTimeout(run, 500));
  }

  function isBrowseOrHomePage() {
    const path = location.pathname || '/';
    if (path === '/') return true;
    if (path.startsWith('/browse')) return true;
    if (path.startsWith('/library')) return true;
    if (path.startsWith('/search')) return true;
    if (path.startsWith('/playlist')) return true;
    if (path.startsWith('/channel')) return true;
    if (path.startsWith('/moods') || path.startsWith('/new_releases')) return true;
    if (document.querySelector('ytmusic-browse-home')) return true;
    if (document.querySelector('ytmusic-home-page')) return true;
    return false;
  }

  function collapsePlayerPage() {
    const layout = getLayout();
    if (!layout) return;

    const state = getPlayerUiState();
    if (state === TARGET_STATE || state === 'FULLSCREEN') {
      setPlayerUiState(layout, 'COLLAPSED');
      log('Collapsed player for browse/home');
    }
    suppressSongMediaWindow();
  }

  /** Keep home/browse usable — never leave the Now Playing overlay on top. */
  function updateBrowseMode() {
    const onBrowse = isBrowseOrHomePage();
    if (onBrowse) {
      document.documentElement.setAttribute('data-ytm-on-browse', 'true');
      setAlwaysFullscreenAttr(false);
      collapsePlayerPage();
    } else {
      document.documentElement.removeAttribute('data-ytm-on-browse');
      if (enabled) setAlwaysFullscreenAttr(true);
    }
  }

  function enforceExpandedPlayer() {
    if (!enabled) {
      setAlwaysFullscreenAttr(false);
      return;
    }

    updateBrowseMode();
    if (isBrowseOrHomePage()) return;

    setAlwaysFullscreenAttr(true);

    const layout = getLayout();
    if (layout) preventBrowserFullscreen(layout);

    const now = Date.now();
    if (now - lastEnforceAt < ENFORCE_COOLDOWN_MS) return;

    if (!isPlaying()) return;

    const state = getPlayerUiState();
    if (!isExpandedState(state)) {
      lastEnforceAt = now;
      expandPlayerPage(false);
    }
  }

  function attachObservers() {
    const layout = getLayout();
    if (!layout || layout.dataset.ytmFsBound) return;
    layout.dataset.ytmFsBound = '1';

    stateObserver = new MutationObserver(() => {
      if (!enabled) return;
      preventBrowserFullscreen(layout);
      const state = layout.getAttribute('player-ui-state');
      if (state !== TARGET_STATE && isPlaying() && !isBrowseOrHomePage()) {
        enforceExpandedPlayer();
      }
    });

    stateObserver.observe(layout, {
      attributes: true,
      attributeFilter: ['player-ui-state']
    });
  }

  function stopWatchers() {
    if (enforceIntervalId) {
      clearInterval(enforceIntervalId);
      enforceIntervalId = null;
    }
    stateObserver?.disconnect();
    stateObserver = null;
  }

  function init() {
    attachSongMediaSuppressor();

    if (!ext()?.isContextValid()) return;

    ext().storageGet([STORAGE_KEY], (result) => {
      enabled = result[STORAGE_KEY] !== false;
      updateBrowseMode();
      attachObservers();
      if (!isBrowseOrHomePage()) enforceExpandedPlayer();
      log('Always expanded player:', enabled ? 'on' : 'off', `(v${EXT_VERSION})`);
    });

    ext().onStorageChanged((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      enabled = changes[STORAGE_KEY].newValue !== false;
      setAlwaysFullscreenAttr(enabled);
      enforceExpandedPlayer();
    });

    ext().onInvalidated(stopWatchers);

    document.addEventListener('yt-navigate-finish', () => {
      setTimeout(() => {
        updateBrowseMode();
        if (!isBrowseOrHomePage()) enforceExpandedPlayer();
      }, 300);
    });

    document.addEventListener('yt-page-data-updated', () => {
      setTimeout(() => {
        updateBrowseMode();
        if (!isBrowseOrHomePage()) enforceExpandedPlayer();
      }, 300);
    });

    enforceIntervalId = setInterval(() => {
      if (!ext()?.isContextValid()) {
        stopWatchers();
        return;
      }
      attachObservers();
      updateBrowseMode();
      if (enabled && !isBrowseOrHomePage()) enforceExpandedPlayer();
    }, 5000);
  }

  window.YtmPlayerFullscreen = {
    expandPlayerPage: () => expandPlayerPage(false),
    minimizePlayerPage() {
      const btn = queryFirst(SELECTORS.minimizeButton);
      if (btn) {
        btn.click();
        return true;
      }
      const layout = getLayout();
      if (layout && isExpandedState(getPlayerUiState())) {
        layout.setAttribute('player-ui-state', 'COLLAPSED');
        return true;
      }
      return false;
    },
    closePlayerPage() {
      const closeBtn = queryFirst(SELECTORS.closeButton);
      if (closeBtn) {
        closeBtn.click();
        return true;
      }
      return window.YtmPlayerFullscreen.minimizePlayerPage();
    },
    maximizePlayerPage() {
      expandPlayerPage(true);
      return true;
    },
    collapsePlayerPage,
    updateBrowseMode,
    isBrowseOrHomePage,
    getPlayerUiState,
    isExpandedState,
    enforceFullscreen: enforceExpandedPlayer,
    enforceExpandedPlayer
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
