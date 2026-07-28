/**
 * Safe Chrome extension API helpers.
 * Reconnects when the MV3 service worker sleeps — only invalidates on real reload.
 */
(function () {
  'use strict';

  (function cleanupLegacyExtensionLoops() {
    [
      'ytm-style-radio-active',
      'ytm-style-radio-artist',
      'ytm-style-radio-seed',
      'ytm-style-radio-rotation',
      'ytm-auto-random-played',
      'ytm-random-session-picks',
      'ytm-shuffle-default-done'
    ].forEach((key) => {
      try {
        sessionStorage.removeItem(key);
      } catch (_) {
        /* ignore */
      }
    });
  })();

  let contextInvalidated = false;
  let keepalivePort = null;
  let keepaliveReconnectTimer = null;
  let heartbeatTimer = null;
  const invalidationCallbacks = [];

  function isContextValid() {
    if (contextInvalidated) return false;
    try {
      if (!chrome?.runtime?.id) {
        contextInvalidated = true;
        return false;
      }
      return true;
    } catch (_) {
      contextInvalidated = true;
      return false;
    }
  }

  function isContextInvalidationError(message) {
    return Boolean(message && /extension context invalidated/i.test(message));
  }

  function isTransientConnectionError(message) {
    return Boolean(
      message &&
        (/could not establish connection/i.test(message) ||
          /receiving end does not exist/i.test(message) ||
          /message port closed/i.test(message))
    );
  }

  function consumeRuntimeError() {
    const err = chrome.runtime.lastError;
    if (!err) return null;
    if (isContextInvalidationError(err.message)) markInvalidated();
    return err.message || '';
  }

  function markInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    stopHeartbeat();
    clearKeepaliveReconnect();
    if (keepalivePort) {
      try {
        keepalivePort.disconnect();
      } catch (_) {
        /* ignore */
      }
      keepalivePort = null;
    }
    showReloadBanner();
    invalidationCallbacks.forEach((fn) => {
      try {
        fn();
      } catch (_) {
        /* ignore cleanup errors */
      }
    });
  }

  function onInvalidated(callback) {
    if (typeof callback === 'function') {
      invalidationCallbacks.push(callback);
    }
  }

  function clearKeepaliveReconnect() {
    if (keepaliveReconnectTimer) {
      clearTimeout(keepaliveReconnectTimer);
      keepaliveReconnectTimer = null;
    }
  }

  function scheduleKeepaliveReconnect(delayMs) {
    if (contextInvalidated || keepaliveReconnectTimer) return;
    keepaliveReconnectTimer = setTimeout(() => {
      keepaliveReconnectTimer = null;
      connectKeepalive();
    }, delayMs);
  }

  function connectKeepalive() {
    if (contextInvalidated) return;
    if (!isContextValid()) return;

    try {
      if (keepalivePort) {
        try {
          keepalivePort.disconnect();
        } catch (_) {
          /* ignore */
        }
        keepalivePort = null;
      }

      keepalivePort = chrome.runtime.connect({ name: 'ytm-keepalive' });
      keepalivePort.onDisconnect.addListener(() => {
        keepalivePort = null;
        if (contextInvalidated) return;
        if (!isContextValid()) {
          markInvalidated();
          return;
        }
        scheduleKeepaliveReconnect(800);
      });
    } catch (_) {
      if (!isContextValid()) {
        markInvalidated();
        return;
      }
      scheduleKeepaliveReconnect(1500);
    }
  }

  function pingBackground() {
    if (!isContextValid() || document.hidden) return;
    try {
      if (keepalivePort) {
        keepalivePort.postMessage({ type: 'ping', t: Date.now() });
      } else {
        connectKeepalive();
      }
      chrome.runtime.sendMessage({ type: 'PING' }, () => {
        const errMsg = consumeRuntimeError();
        if (errMsg && isTransientConnectionError(errMsg)) {
          scheduleKeepaliveReconnect(500);
        }
      });
    } catch (err) {
      if (isContextInvalidationError(err?.message)) markInvalidated();
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(pingBackground, 20000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pingBackground();
    });
    pingBackground();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function storageGet(keys, callback) {
    if (!isContextValid()) {
      if (typeof callback === 'function') callback({});
      return;
    }
    try {
      chrome.storage.local.get(keys, (result) => {
        const errMsg = consumeRuntimeError();
        if (contextInvalidated || errMsg) {
          callback({});
          return;
        }
        callback(result || {});
      });
    } catch (err) {
      if (isContextInvalidationError(err?.message)) markInvalidated();
      callback({});
    }
  }

  function storageSet(data, callback) {
    if (!isContextValid()) {
      if (typeof callback === 'function') callback();
      return;
    }
    try {
      chrome.storage.local.set(data, () => {
        consumeRuntimeError();
        if (typeof callback === 'function') callback();
      });
    } catch (err) {
      if (isContextInvalidationError(err?.message)) markInvalidated();
      if (typeof callback === 'function') callback();
    }
  }

  function sendMessage(message, callback, attempt) {
    const tryCount = attempt || 0;
    if (!isContextValid()) return;

    try {
      chrome.runtime.sendMessage(message, (response) => {
        const errMsg = consumeRuntimeError();
        if (errMsg && isTransientConnectionError(errMsg) && tryCount < 3) {
          setTimeout(() => sendMessage(message, callback, tryCount + 1), 120 * (tryCount + 1));
          return;
        }
        if (typeof callback === 'function') callback(response);
      });
    } catch (err) {
      if (isContextInvalidationError(err?.message)) {
        markInvalidated();
        return;
      }
      if (tryCount < 3) {
        setTimeout(() => sendMessage(message, callback, tryCount + 1), 120 * (tryCount + 1));
        return;
      }
    }
  }

  function onStorageChanged(listener) {
    if (!isContextValid()) return;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (!isContextValid()) return;
        listener(changes, area);
      });
    } catch (err) {
      if (isContextInvalidationError(err?.message)) markInvalidated();
    }
  }

  function onMessage(listener) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!isContextValid()) return false;
        return listener(message, sender, sendResponse);
      });
    } catch (err) {
      if (isContextInvalidationError(err?.message)) markInvalidated();
    }
  }

  let reloadBannerShown = false;

  function showReloadBanner() {
    if (reloadBannerShown || !document.documentElement) return;
    reloadBannerShown = true;

    const banner = document.createElement('div');
    banner.id = 'ytm-ext-reload-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = 'YouTube Music Float Dock was updated — refresh this page (F5) to reconnect.';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;' +
      'background:#1a1a1a;color:#fff;font:13px/1.4 system-ui,sans-serif;text-align:center;' +
      'border-bottom:1px solid #444;box-shadow:0 2px 8px rgba(0,0,0,.4);';
    document.documentElement.appendChild(banner);
  }

  connectKeepalive();
  startHeartbeat();

  window.YtmExtension = {
    isContextValid,
    markInvalidated,
    onInvalidated,
    storageGet,
    storageSet,
    sendMessage,
    onStorageChanged,
    onMessage,
    showReloadBanner,
    pingBackground
  };
})();
