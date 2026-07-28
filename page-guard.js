/**
 * Page-world guard: blocks programmatic browser fullscreen (no user gesture).
 * Runs in MAIN world so it intercepts YouTube Music's own player code.
 */
(function () {
  'use strict';

  if (window.__ytmPageGuardInstalled) return;
  window.__ytmPageGuardInstalled = true;

  function hasUserGesture() {
    return Boolean(navigator.userActivation?.isActive);
  }

  function patchRequestFullscreen(proto, method) {
    if (!proto) return;
    const original = proto[method];
    if (typeof original !== 'function') return;

    proto[method] = function ytmGuardedRequestFullscreen(...args) {
      if (!hasUserGesture()) {
        return Promise.resolve();
      }
      try {
        return original.apply(this, args);
      } catch (_) {
        return Promise.resolve();
      }
    };
  }

  patchRequestFullscreen(Element.prototype, 'requestFullscreen');
  patchRequestFullscreen(Element.prototype, 'webkitRequestFullscreen');
  patchRequestFullscreen(HTMLVideoElement.prototype, 'requestFullscreen');
  patchRequestFullscreen(HTMLVideoElement.prototype, 'webkitRequestFullscreen');
})();
