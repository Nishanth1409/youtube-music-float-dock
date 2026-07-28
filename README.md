# YouTube Music Float Dock

**Version:** 1.21.9 (Manifest V3)  
**Last updated:** 8 July 2026 (policy check)  
**Scope:** [music.youtube.com](https://music.youtube.com) only — regular YouTube is never affected.

A Chrome extension with a **floating control dock**, **HQ playback**, **window modes** (fullscreen F11, maximize, normal, minimize), **Picture-in-Picture with controls**, and **random play** from your local listen history.

Installed from: `D:\Projects\extensions\youtube-music-float-dock`  
YouTube Music access: Chrome PWA in **Relax** App Group, or [music.youtube.com](https://music.youtube.com).

---

## Features

### Floating dock (right side of the player)

- **Drag handle** — move dock up/down (`floatDockTopPercent`, default 15%)
- **Display menu** — Fullscreen (F11), Maximized, Normal, Minimize to taskbar
- **PiP** — Picture-in-Picture with play/pause and back-to-tab
- **Random** — pick a track from your **local listen history** (no server)

### Popup (extension icon)

- **HQ playback** toggle — requests highest quality the player exposes (audio + video shown normally)
- **Show float dock** toggle
- **Auto fullscreen on open** — maximize/fullscreen when YouTube Music loads
- **Dock vertical position** slider (3%–92%)
- Track title, artist, playback type (Song/Video), quality label

### Playback behavior

- **Does not hide video** or force Song-only mode by default
- Uses YouTube player API for **max quality** when HQ mode is on
- **Playlist-aware** — re-applies quality on each new track
- **SPA-aware** — handles navigation without full page reload

---

## Installation (unpacked / developer)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `D:\Projects\extensions\youtube-music-float-dock`
4. Open [https://music.youtube.com](https://music.youtube.com)
5. Click the extension icon → enable **HQ playback** and **Show float dock** as you like

To reload after code changes: `chrome://extensions` → **Reload** on this extension, then refresh the YouTube Music tab.

---

## File structure

```text
youtube-music-float-dock/
├── manifest.json           # MV3
├── background.js           # Window modes, PiP coordination, auto-fullscreen
├── content.js              # HQ quality, player status for popup
├── extension-utils.js      # Shared helpers
├── listen-history.js       # Local listen history for random play
├── float-random.js         # Floating dock UI + random + PiP triggers
├── pip-aspect-ratio.js     # PiP sizing helper (web_accessible)
├── page-guard.js           # Scope guard
├── player-fullscreen.js    # Fullscreen helpers
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── styles/
│   └── float-random.css
├── icons/
├── README.md
├── PRIVACY.md
└── LICENSE
```

---

## Local storage keys

| Key | Purpose |
|-----|---------|
| `hqModeEnabled` | HQ playback on/off (legacy: `audioOnlyEnabled`) |
| `floatRandomEnabled` | Show floating dock |
| `autoWindowFullscreenOnOpen` | Auto fullscreen/maximize when YTM opens |
| `floatDockTopPercent` | Dock vertical position (3–92) |
| `listenHistory` | Titles/artists/video ids for random play |

See [PRIVACY.md](PRIVACY.md) for full privacy disclosure.

---

## Testing checklist

### Setup

- [ ] Extension loads at `chrome://extensions` without errors
- [ ] Popup opens on `music.youtube.com` with toggles and track info
- [ ] Settings persist after browser restart

### Scope

- [ ] `youtube.com/watch` — popup shows off-page message; no dock injected
- [ ] Only `music.youtube.com` has content scripts (DevTools → Sources)

### Float dock

- [ ] Dock appears on right when **Show float dock** is on
- [ ] Drag handle moves dock; position saved
- [ ] Display menu: F11, maximize, normal, minimize work
- [ ] PiP opens with controls; back returns to tab
- [ ] Random plays from history after you have listened to a few tracks

### HQ playback

- [ ] With HQ on, console `[YTM` logs show quality applied per track
- [ ] Skip next/previous — each track handled once, no error flood

---

## Updating selectors

If YouTube Music changes its UI:

1. Play a track on `music.youtube.com`
2. DevTools (F12) → inspect player bar, PiP, expand buttons
3. Update `SELECTORS` in `content.js` and any `aria-label` queries in `float-random.js`

---

## Chrome Web Store (if publishing)

**Short description (132 chars):**

```
Floating dock for YouTube Music — F11, PiP, HQ playback, random from your listens. music.youtube.com only.
```

**Single purpose:**

```
Provide a floating control dock and optional highest-quality playback on YouTube Music only.
```

**Permissions:**

| Permission | Why |
|------------|-----|
| `storage` | Preferences + local listen history |
| `activeTab`, `tabs`, `windows` | Window modes, PiP, fullscreen from dock |
| `https://music.youtube.com/*` | Content scripts on YouTube Music only |

---

## License

MIT — see [LICENSE](LICENSE).

## Privacy

See [PRIVACY.md](PRIVACY.md).
