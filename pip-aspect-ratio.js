/**
 * Locks Document PiP outer window size to content aspect ratio.
 * Loaded into the PiP window via chrome-extension:// URL (CSP-safe).
 */
(function () {
  'use strict';

  const root = document.documentElement;
  const ratio = parseFloat(root.dataset.ytmPipRatio);
  const minEdge = parseInt(root.dataset.ytmPipMinEdge, 10) || 160;

  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return;

  let lastW = window.innerWidth || 0;
  let lastH = window.innerHeight || 0;
  let adjusting = false;
  let resizeAxis = null;
  let settleTimer = null;

  function snapToRatio() {
    if (adjusting) return;

    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!w || !h) return;

    const dw = w - lastW;
    const dh = h - lastH;
    if (Math.abs(dw) < 1 && Math.abs(dh) < 1) return;

    if (!resizeAxis) {
      resizeAxis = Math.abs(dw) >= Math.abs(dh) ? 'w' : 'h';
    }

    let newW = w;
    let newH = h;
    if (resizeAxis === 'w') {
      newH = Math.max(minEdge, Math.round(w / ratio));
    } else {
      newW = Math.max(minEdge, Math.round(h * ratio));
    }

    if (newW !== w || newH !== h) {
      adjusting = true;
      try {
        window.resizeTo(newW, newH);
        lastW = newW;
        lastH = newH;
      } catch (_) {
        lastW = w;
        lastH = h;
      } finally {
        adjusting = false;
      }
    } else {
      lastW = w;
      lastH = h;
    }

    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      resizeAxis = null;
    }, 50);
  }

  window.addEventListener('resize', snapToRatio);
  snapToRatio();
})();
