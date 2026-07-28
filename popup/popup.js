'use strict';

const STORAGE_KEY = 'hqModeEnabled';
const LEGACY_STORAGE_KEY = 'audioOnlyEnabled';
const FLOAT_KEY = 'floatRandomEnabled';
const DOCK_TOP_KEY = 'floatDockTopPercent';

const toggle = document.getElementById('hqToggle');
const floatToggle = document.getElementById('floatToggle');
const dockTopSlider = document.getElementById('dockTopSlider');
const dockTopValue = document.getElementById('dockTopValue');
const statusBadge = document.getElementById('statusBadge');
const randomBadge = document.getElementById('randomBadge');
const trackTitle = document.getElementById('trackTitle');
const trackArtist = document.getElementById('trackArtist');
const playbackType = document.getElementById('playbackType');
const qualityLabel = document.getElementById('qualityLabel');
const videoResolution = document.getElementById('videoResolution');
const trackNote = document.getElementById('trackNote');

function setBadge(enabled) {
  statusBadge.textContent = enabled ? 'Enabled' : 'Disabled';
  statusBadge.className = 'badge ' + (enabled ? 'badge-enabled' : 'badge-disabled');
}

function setRandomBadge(enabled) {
  randomBadge.textContent = enabled ? 'On' : 'Off';
  randomBadge.className = 'badge ' + (enabled ? 'badge-enabled' : 'badge-disabled');
}

function setDockTopDisplay(percent) {
  const value = Math.min(92, Math.max(3, Number(percent) || 15));
  dockTopSlider.value = String(value);
  dockTopValue.textContent = `${value}%`;
}

function setPlaybackDisplay(type) {
  playbackType.textContent = type || '—';
  playbackType.className = '';
  if (type === 'Song') playbackType.classList.add('playback-song');
  if (type === 'Video') playbackType.classList.add('playback-video');
}

function showOffPageMessage() {
  trackTitle.textContent = '—';
  trackArtist.textContent = '—';
  setPlaybackDisplay('—');
  qualityLabel.textContent = '—';
  videoResolution.textContent = '—';
  trackNote.textContent = 'Open music.youtube.com and play a track to see details here.';
  trackNote.classList.remove('hidden');
}

function updateTrackUI(status) {
  if (!status || !status.onYouTubeMusic) {
    showOffPageMessage();
    return;
  }

  trackTitle.textContent = status.title || '—';
  trackArtist.textContent = status.artist || '—';
  setPlaybackDisplay(status.playbackType);
  qualityLabel.textContent = status.qualityLabel || status.quality || '—';
  videoResolution.textContent = status.videoResolution || '—';

  trackNote.classList.add('hidden');
  trackNote.textContent = '';

  if (status.enabled) {
    const target = status.targetQuality && status.targetQuality !== '—'
      ? status.targetQuality
      : 'highest available';
    trackNote.textContent = `Audio and video at ${target}. Tap Random on the dock for a pick from your listens.`;
    trackNote.classList.remove('hidden');
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function isYouTubeMusicTab(tab) {
  return tab && tab.url && tab.url.startsWith('https://music.youtube.com/');
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    return null;
  }
}

async function sendToBackground(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (_) {
    return null;
  }
}

async function refreshStatus() {
  const tab = await getActiveTab();

  if (!isYouTubeMusicTab(tab)) {
    showOffPageMessage();
    return;
  }

  const [status, randomSettings, cached] = await Promise.all([
    sendToContent(tab.id, { type: 'GET_STATUS' }),
    sendToContent(tab.id, { type: 'GET_RANDOM_SETTINGS' }),
    sendToBackground({ type: 'GET_CACHED_STATUS' })
  ]);

  const stored = await chrome.storage.local.get([DOCK_TOP_KEY]);
  setDockTopDisplay(stored[DOCK_TOP_KEY] ?? randomSettings?.dockTopPercent ?? 15);

  if (randomSettings) {
    floatToggle.checked = randomSettings.floatEnabled !== false;
    setDockTopDisplay(randomSettings.dockTopPercent ?? stored[DOCK_TOP_KEY] ?? 15);
    setRandomBadge(floatToggle.checked);
  }

  const resolvedStatus = status || cached?.status;
  if (resolvedStatus) {
    updateTrackUI(resolvedStatus);
  } else {
    trackNote.textContent = 'Reload the YouTube Music tab if track info does not appear.';
    trackNote.classList.remove('hidden');
  }
}

async function setEnabled(enabled) {
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  setBadge(enabled);
  toggle.checked = enabled;

  const tab = await getActiveTab();
  if (isYouTubeMusicTab(tab)) {
    await sendToContent(tab.id, { type: 'SET_ENABLED', enabled });
  }

  await refreshStatus();
}

async function setRandomSettings() {
  const floatEnabled = floatToggle.checked;
  const dockTopPercent = Number(dockTopSlider.value);

  await chrome.storage.local.set({
    [FLOAT_KEY]: floatEnabled,
    [DOCK_TOP_KEY]: dockTopPercent
  });

  setRandomBadge(floatEnabled);
  setDockTopDisplay(dockTopPercent);

  const tab = await getActiveTab();
  if (isYouTubeMusicTab(tab)) {
    await sendToContent(tab.id, {
      type: 'SET_RANDOM_SETTINGS',
      floatEnabled,
      dockTopPercent
    });
  }
}

async function setDockTopOnly() {
  const dockTopPercent = Number(dockTopSlider.value);
  setDockTopDisplay(dockTopPercent);
  await chrome.storage.local.set({ [DOCK_TOP_KEY]: dockTopPercent });

  const tab = await getActiveTab();
  if (isYouTubeMusicTab(tab)) {
    await sendToContent(tab.id, {
      type: 'SET_DOCK_TOP_PERCENT',
      dockTopPercent
    });
  }
}

toggle.addEventListener('change', () => {
  setEnabled(toggle.checked);
});

floatToggle.addEventListener('change', setRandomSettings);
dockTopSlider.addEventListener('input', setDockTopOnly);
dockTopSlider.addEventListener('change', setRandomSettings);

chrome.storage.local.get(
  [STORAGE_KEY, LEGACY_STORAGE_KEY, FLOAT_KEY, DOCK_TOP_KEY],
  (result) => {
  let enabled = true;
  if (result[STORAGE_KEY] !== undefined) {
    enabled = result[STORAGE_KEY] !== false;
  } else if (result[LEGACY_STORAGE_KEY] !== undefined) {
    enabled = result[LEGACY_STORAGE_KEY] !== false;
  }

  toggle.checked = enabled;
  floatToggle.checked = result[FLOAT_KEY] !== false;
  setDockTopDisplay(result[DOCK_TOP_KEY] ?? 15);

  setBadge(enabled);
  setRandomBadge(floatToggle.checked);
  refreshStatus();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STATUS_UPDATE' && message.status) {
    toggle.checked = message.status.enabled;
    setBadge(message.status.enabled);
    updateTrackUI(message.status);
  }
});

document.addEventListener('DOMContentLoaded', refreshStatus);
