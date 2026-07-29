# YouTube Music Float Dock

Chrome **Manifest V3** extension for [music.youtube.com](https://music.youtube.com) only (regular YouTube is never touched).

Floating control dock, HQ playback, window modes (F11 / maximize / normal / minimize), Picture-in-Picture with controls, and **random play** from local listen history.

**Version:** 1.22.0  

---

## Install from scratch

### 1. Get the extension
```bash
git clone https://github.com/Nishanth1409/youtube-music-float-dock.git
cd youtube-music-float-dock
```

### 2. Load in Chrome
1. Open `chrome://extensions`  
2. Enable **Developer mode**  
3. **Load unpacked** → select **this repo folder** (the one that contains `manifest.json`)  
4. Open [https://music.youtube.com](https://music.youtube.com)  
5. Click the extension icon → turn on **HQ playback** and **Show float dock** as you like  

### 3. After code changes
`chrome://extensions` → **Reload** on this extension → refresh the YouTube Music tab.

---

## Features

### Floating dock
- Drag handle (vertical position, default ~15%)  
- Display menu: Fullscreen (F11), Maximized, Normal, Minimize  
- PiP with play/pause and back-to-tab  
- Random from **local** listen history (no server)

### Popup
- HQ playback toggle  
- Show float dock toggle  
- Auto fullscreen on open  
- Dock position slider  
- Track / artist / quality status  

### Playback
- Does not hide video by default  
- Re-applies quality on each track / SPA navigation  

---

## Project layout

```text
youtube-music-float-dock/
├── manifest.json
├── background.js
├── content.js
├── extension-utils.js
├── listen-history.js
├── float-random.js
├── pip-aspect-ratio.js
├── page-guard.js
├── player-fullscreen.js
├── popup/
├── styles/
├── icons/
├── README.md
└── PRIVACY.md
```

---

## Pro tips

- Use a dedicated Chrome profile or PWA window for YouTube Music if you also use heavy extensions elsewhere.  
- Random play needs some listen history first — play a few tracks, then try Random.  
- See **PRIVACY.md** for data handling (local-only history).

## License

See `LICENSE`. Contact the author before commercial reuse.
