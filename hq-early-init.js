/**
 * Tells the MAIN-world HQ helper whether forcing is on, before YouTube Music
 * issues its first /player request. content.js runs at document_idle, which is
 * too late for a song that starts playing as soon as the window opens.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'hqModeEnabled';
  const LEGACY_STORAGE_KEY = 'audioOnlyEnabled';

  function publish(enabled) {
    try {
      window.postMessage(
        { source: 'ytm-float-dock', type: 'HQ_AUDIO_SET', enabled: Boolean(enabled) },
        '*'
      );
    } catch (_) {
      /* ignore */
    }
  }

  // Mirrors loadEnabledState() in content.js so both agree on the default.
  function resolveEnabled(result) {
    const stored = result || {};
    if (stored[STORAGE_KEY] !== undefined) return stored[STORAGE_KEY] !== false;
    if (stored[LEGACY_STORAGE_KEY] !== undefined) return stored[LEGACY_STORAGE_KEY] !== false;
    return true;
  }

  try {
    chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY], (result) => {
      void chrome.runtime.lastError;
      publish(resolveEnabled(result));
    });
  } catch (_) {
    publish(true);
  }
})();
