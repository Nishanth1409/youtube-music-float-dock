'use strict';

const YTM_URL_PREFIX = 'https://music.youtube.com/';

let lastStatus = null;
const autoFullscreenTabIds = new Set();
/** Saved display mode when user minimizes via dock or PiP. */
const dockMinimizedRestore = new Map();
/** True if the last minimize came from PiP (vs dock button). */
const pipMinimizedWindows = new Set();
/** Block accidental restore briefly after track changes (media can wake the window). */
const suppressRestoreUntil = new Map();
const pendingRestoreTimers = new Map();
const lastWindowState = new Map();
const pendingDisplayUpdate = new Set();
const pipSavedWindowState = new Map();
const DISPLAY_CYCLE = ['fullscreen', 'maximized', 'normal', 'minimized'];
const displayCycleStep = new Map();

const DISPLAY_GUARD_MS = 600;
const TRACK_SUPPRESS_MS = 5000;
const TASKBAR_RESTORE_DELAY_MS = 450;

function isWindowFullscreen(state) {
  return state === 'fullscreen' || state === 'locked-fullscreen';
}

function detectDisplayMode(win) {
  if (!win) return 'normal';
  if (isWindowFullscreen(win.state)) return 'fullscreen';
  if (win.state === 'maximized') return 'maximized';
  return 'normal';
}

function beginDisplayGuard(windowId) {
  pendingDisplayUpdate.add(windowId);
  setTimeout(() => pendingDisplayUpdate.delete(windowId), DISPLAY_GUARD_MS);
}

function clearDockMinimizeSession(windowId) {
  dockMinimizedRestore.delete(windowId);
  pipMinimizedWindows.delete(windowId);
  suppressRestoreUntil.delete(windowId);
  const timer = pendingRestoreTimers.get(windowId);
  if (timer) {
    clearTimeout(timer);
    pendingRestoreTimers.delete(windowId);
  }
}

function hasMinimizeSession(windowId) {
  return dockMinimizedRestore.has(windowId);
}

function isTrackSuppressActive(windowId) {
  return Date.now() < (suppressRestoreUntil.get(windowId) || 0);
}

async function ensureActiveTab(windowId, tabId) {
  if (!tabId) return;
  const win = await chrome.windows.get(windowId, { populate: true });
  const tab = win.tabs?.find((t) => t.id === tabId);
  if (tab?.active) return;
  await chrome.tabs.update(tabId, { active: true });
}

async function ensureUnminimized(windowId) {
  const win = await chrome.windows.get(windowId);
  if (win.state !== 'minimized') return win;

  clearDockMinimizeSession(windowId);
  beginDisplayGuard(windowId);
  await chrome.windows.update(windowId, { state: 'normal', focused: true });
  return chrome.windows.get(windowId);
}

async function forceMinimizeWindow(windowId) {
  beginDisplayGuard(windowId);
  const win = await chrome.windows.get(windowId);
  if (isWindowFullscreen(win.state)) {
    await chrome.windows.update(windowId, { state: 'normal', focused: false });
  }
  await chrome.windows.update(windowId, { state: 'minimized', focused: false });
}

async function enterWindowFullscreen(windowId, options = {}) {
  if (windowId === undefined) return { ok: false, reason: 'no_window' };
  try {
    let win;
    if (options.allowUnminimize === false) {
      win = await chrome.windows.get(windowId);
      if (win.state === 'minimized' || hasMinimizeSession(windowId)) {
        return { ok: false, reason: 'minimized' };
      }
    } else {
      win = await ensureUnminimized(windowId);
    }

    if (detectDisplayMode(win) === 'fullscreen') {
      return { ok: true, state: 'fullscreen', already: true };
    }
    beginDisplayGuard(windowId);
    await chrome.windows.update(windowId, { state: 'fullscreen', focused: true });
    return { ok: true, state: 'fullscreen' };
  } catch (err) {
    return { ok: false, reason: err?.message || 'fullscreen_failed' };
  }
}

async function exitWindowFullscreen(windowId, targetDisplay) {
  beginDisplayGuard(windowId);
  const win = await chrome.windows.get(windowId);
  if (isWindowFullscreen(win.state)) {
    await chrome.windows.update(windowId, { state: 'normal', focused: true });
  }
  if (targetDisplay && targetDisplay !== 'normal') {
    await chrome.windows.update(windowId, { state: targetDisplay, focused: true });
  }
  return { ok: true, state: targetDisplay || 'normal', windowId };
}

async function toggleWindowFullscreen(windowId) {
  const win = await chrome.windows.get(windowId);
  if (detectDisplayMode(win) === 'fullscreen') {
    return exitWindowFullscreen(windowId, 'normal');
  }
  return enterWindowFullscreen(windowId);
}

async function applyRestoreState(windowId, saved) {
  if (!saved || saved === 'normal') {
    beginDisplayGuard(windowId);
    await chrome.windows.update(windowId, { state: 'normal', focused: true });
    return { ok: true, state: 'normal' };
  }

  if (saved === 'fullscreen') {
    return enterWindowFullscreen(windowId);
  }

  beginDisplayGuard(windowId);
  await chrome.windows.update(windowId, { state: saved, focused: true });
  return { ok: true, state: saved };
}

async function minimizeViaDock(windowId, forPip = false) {
  const win = await chrome.windows.get(windowId);
  const saved = detectDisplayMode(win);
  dockMinimizedRestore.set(windowId, saved);
  if (forPip) {
    pipMinimizedWindows.add(windowId);
  } else {
    pipMinimizedWindows.delete(windowId);
  }

  beginDisplayGuard(windowId);
  if (isWindowFullscreen(win.state)) {
    await chrome.windows.update(windowId, { state: 'normal', focused: false });
  }
  await chrome.windows.update(windowId, { state: 'minimized', focused: false });
  return saved;
}

function markTrackTransition(windowId) {
  if (!windowId || !hasMinimizeSession(windowId)) return;
  suppressRestoreUntil.set(windowId, Date.now() + TRACK_SUPPRESS_MS);

  const timer = pendingRestoreTimers.get(windowId);
  if (timer) {
    clearTimeout(timer);
    pendingRestoreTimers.delete(windowId);
  }
}

async function handleTrackChanged(windowId) {
  if (!windowId || !hasMinimizeSession(windowId)) return;

  markTrackTransition(windowId);

  try {
    const win = await chrome.windows.get(windowId);
    if (win.state === 'minimized') return;
    // Re-minimize only when media wakes the window during a track transition.
    await forceMinimizeWindow(windowId);
  } catch (_) {
    clearDockMinimizeSession(windowId);
  }
}

function scheduleTaskbarRestore(windowId) {
  const existing = pendingRestoreTimers.get(windowId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    pendingRestoreTimers.delete(windowId);

    if (!hasMinimizeSession(windowId)) return;

    try {
      const win = await chrome.windows.get(windowId);
      if (win.state === 'minimized') return;
      if (pendingDisplayUpdate.has(windowId)) return;

      // Only re-minimize during the short track-change suppress window.
      // User taskbar click after that must restore the window.
      if (isTrackSuppressActive(windowId)) {
        await forceMinimizeWindow(windowId);
        return;
      }

      const saved = dockMinimizedRestore.get(windowId);
      clearDockMinimizeSession(windowId);
      await applyRestoreState(windowId, saved);
    } catch (_) {
      clearDockMinimizeSession(windowId);
    }
  }, TASKBAR_RESTORE_DELAY_MS);

  pendingRestoreTimers.set(windowId, timer);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ytm-keepalive') return;
  port.onMessage.addListener((message) => {
    if (message?.type === 'ping') {
      try {
        port.postMessage({ type: 'pong', t: message.t });
      } catch (_) {
        /* port may close */
      }
    }
  });
});

async function setWindowDisplay(windowId, tabId, display) {
  const stepByState = { fullscreen: 0, maximized: 1, normal: 2, minimized: 3 };
  if (stepByState[display] !== undefined) {
    displayCycleStep.set(windowId, stepByState[display]);
  }

  if (display === 'minimized') {
    const saved = await minimizeViaDock(windowId, false);
    return { ok: true, state: display, restoreOnTaskbar: saved };
  }

  clearDockMinimizeSession(windowId);

  const win = await ensureUnminimized(windowId);
  const mode = detectDisplayMode(win);
  if (mode === display) {
    return { ok: true, state: display, already: true };
  }

  if (display === 'fullscreen') {
    return enterWindowFullscreen(windowId);
  }

  if (mode === 'fullscreen') {
    await exitWindowFullscreen(windowId, display);
    await ensureActiveTab(windowId, tabId);
    return { ok: true, state: display, windowId };
  }

  beginDisplayGuard(windowId);
  await chrome.windows.update(windowId, { state: display, focused: true });
  await ensureActiveTab(windowId, tabId);
  return { ok: true, state: display, windowId };
}

async function savePipWindowState(windowId) {
  const win = await chrome.windows.get(windowId);
  const saved = detectDisplayMode(win);
  pipSavedWindowState.set(windowId, saved);
  return { ok: true, saved };
}

function displayStepForMode(mode) {
  return { fullscreen: 0, maximized: 1, normal: 2, minimized: 3 }[mode];
}

async function restoreFromPip(windowId, tabId) {
  const saved = pipSavedWindowState.get(windowId) || 'maximized';
  pipSavedWindowState.delete(windowId);
  clearDockMinimizeSession(windowId);

  const step = displayStepForMode(saved);
  if (step !== undefined) {
    displayCycleStep.set(windowId, step);
  }

  if (saved === 'minimized') {
    beginDisplayGuard(windowId);
    await chrome.windows.update(windowId, { state: 'minimized', focused: false });
    return { ok: true, state: saved };
  }

  await ensureUnminimized(windowId);

  if (saved === 'fullscreen') {
    return enterWindowFullscreen(windowId);
  }

  beginDisplayGuard(windowId);
  await chrome.windows.update(windowId, { state: saved, focused: true });
  await ensureActiveTab(windowId, tabId);
  return { ok: true, state: saved };
}

async function handleWindowControl(action, sender, options = {}) {
  const tabId = sender.tab?.id;
  const windowId = options.windowId ?? sender.tab?.windowId;

  if (!tabId || windowId === undefined) {
    return { ok: false, reason: 'no_tab' };
  }

  try {
    if (action === 'enter-fullscreen') {
      return enterWindowFullscreen(windowId);
    }

    if (action === 'toggle-fullscreen') {
      return toggleWindowFullscreen(windowId);
    }

    if (action === 'set-display') {
      const display = options.display;
      if (!DISPLAY_CYCLE.includes(display)) {
        return { ok: false, reason: 'invalid_display' };
      }
      return setWindowDisplay(windowId, tabId, display);
    }

    if (action === 'cycle-display') {
      let step = displayCycleStep.get(windowId);
      if (step === undefined) step = -1;
      step = (step + 1) % DISPLAY_CYCLE.length;
      return setWindowDisplay(windowId, tabId, DISPLAY_CYCLE[step]);
    }

    if (action === 'fullscreen' || action === 'maximize') {
      return { ok: false, reason: 'use_set_display' };
    }

    if (action === 'save-pip-state') {
      return savePipWindowState(windowId);
    }

    if (action === 'restore-from-pip') {
      return restoreFromPip(windowId, tabId);
    }

    if (action === 'minimize') {
      const forPip = options.forPip === true;
      const saved = await minimizeViaDock(windowId, forPip);
      displayCycleStep.set(windowId, 3);
      return { ok: true, state: 'minimized', forPip, restoreOnTaskbar: saved };
    }

    if (action === 'close') {
      const win = await chrome.windows.get(windowId, { populate: true });
      if (win.tabs?.length === 1) {
        await chrome.windows.remove(windowId);
      } else {
        await chrome.tabs.remove(tabId);
      }
      return { ok: true };
    }

    return { ok: false, reason: 'unknown_action' };
  } catch (err) {
    return { ok: false, reason: err?.message || 'window_control_failed' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STATUS_UPDATE') {
    if (message.status) {
      lastStatus = message.status;
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'GET_CACHED_STATUS') {
    sendResponse({ status: lastStatus });
    return true;
  }

  if (message.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'TRACK_CHANGED' || message.type === 'TRACK_ENDED') {
    handleTrackChanged(sender.tab?.windowId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'CLEAR_PIP_MINIMIZE') {
    const windowId = sender.tab?.windowId;
    if (windowId !== undefined) {
      // Only clear keep-minimized when user intentionally exits PiP.
      clearDockMinimizeSession(windowId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'FOCUS_YTM_TAB') {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    const tasks = [];

    // During track-suppress, don't focus/pop the minimized window.
    // Outside that window, allow focus (user may be returning).
    if (windowId !== undefined && hasMinimizeSession(windowId) && isTrackSuppressActive(windowId)) {
      sendResponse({ ok: true, skipped: 'track_suppress' });
      return false;
    }

    if (tabId !== undefined) {
      tasks.push(chrome.tabs.update(tabId, { active: true }));
    }
    if (windowId !== undefined) {
      tasks.push(
        chrome.windows.get(windowId).then(async (win) => {
          if (win.state === 'minimized') return;
          await chrome.windows.update(windowId, { focused: true });
        })
      );
    }
    Promise.all(tasks)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'WINDOW_CONTROL') {
    handleWindowControl(message.action, sender, message).then(sendResponse);
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url?.startsWith(YTM_URL_PREFIX)) return;
  if (!tab.windowId) return;
  if (autoFullscreenTabIds.has(tabId)) return;

  autoFullscreenTabIds.add(tabId);
  setTimeout(async () => {
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.state === 'minimized' || hasMinimizeSession(tab.windowId)) {
        return;
      }
      await enterWindowFullscreen(tab.windowId, { allowUnminimize: false });
    } catch (_) {
      /* ignore */
    }
  }, 400);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  autoFullscreenTabIds.delete(tabId);
});

chrome.windows.onBoundsChanged.addListener((win) => {
  const prev = lastWindowState.get(win.id);
  lastWindowState.set(win.id, win.state);

  if (prev === undefined) return;
  if (prev !== 'minimized' || win.state === 'minimized') return;
  if (!hasMinimizeSession(win.id)) return;
  if (pendingDisplayUpdate.has(win.id)) return;

  scheduleTaskbarRestore(win.id);
});

chrome.windows.onRemoved.addListener((windowId) => {
  clearDockMinimizeSession(windowId);
  pendingDisplayUpdate.delete(windowId);
  pipSavedWindowState.delete(windowId);
  displayCycleStep.delete(windowId);
  lastWindowState.delete(windowId);
});
