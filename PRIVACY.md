# Privacy Policy — YouTube Music Float Dock

**Last updated:** 8 July 2026 (policy check)  
**Extension version:** 1.21.9

## Summary

This extension collects **no personal data**, uses **no analytics**, and sends **no information** to external servers. All preferences and listen history stay **on your device** in Chrome local storage.

---

## Data stored locally

Chrome `chrome.storage.local`:

| Key | Purpose |
|-----|---------|
| `hqModeEnabled` | HQ playback on/off (reads legacy `audioOnlyEnabled` if present) |
| `floatRandomEnabled` | Show or hide the floating dock |
| `autoWindowFullscreenOnOpen` | Auto fullscreen/maximize when YouTube Music opens |
| `floatDockTopPercent` | Saved vertical position of the dock (3–92%) |
| `listenHistory` | Songs you played (title, artist, video id, timestamp) for **random play only** |

Session-only data (not synced, cleared when tab/session ends) may include PiP/window guard flags inside the extension scripts — never transmitted.

This data stays on your computer and is not uploaded.

---

## Data read from YouTube Music

While a YouTube Music tab is open, content scripts read **visible player information** from the page:

- Song title, artist, video id (for popup display and local listen history)
- Playback type (Song/Video) and quality labels (popup only)
- Player state for dock controls (play/pause, PiP)

Used only inside your browser. Never sold, shared, or sent to a backend.

---

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Save toggles, dock position, and listen history |
| `activeTab` | Act on the current YouTube Music tab from the popup/dock |
| `tabs` | Find and focus the YouTube Music tab (e.g. back from PiP) |
| `windows` | Fullscreen, maximize, minimize, PiP window coordination |
| `https://music.youtube.com/*` | Run scripts **only** on YouTube Music |

The extension does **not** request `youtube.com` or other sites.

---

## Background service worker

`background.js` handles window display changes and PiP coordination. It does not contact external URLs or collect analytics.

---

## Third parties

No advertising, analytics, or third-party SDKs.

---

## Contact

For privacy questions, use the project repository or Chrome Web Store developer contact when listed.

---

## Changes

Policy updates ship with new extension versions in this folder and on the Chrome Web Store listing when published.
