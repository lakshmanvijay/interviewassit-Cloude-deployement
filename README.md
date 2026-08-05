# InterviewAssist — Screen-Hidden AI Interview Overlay

A screen-hidden assistant for Windows. **Visible on your monitor, invisible to screen-sharing tools** (Zoom, Teams, Meet, OBS). It runs on cloud AI (Cerebras for answers, Groq for voice-to-text and screenshot analysis) and can **listen continuously** to spoken questions and answer them hands-free.

> Pipeline: **microphone → Groq speech-to-text → Cerebras → answer on screen**

---

## 🔒 How the screen hiding works

On Windows, Electron's `setContentProtection(true)` calls the Win32 API
`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`, which excludes the
window from any screen capture (Zoom/Teams/Meet share, OBS, Snipping Tool,
PrintScreen) while keeping it fully visible on your physical monitor.

---

## 🚀 Quick start

### 1. Install app dependencies
```bash
npm install
```

### 2. Run
```bash
npm start
```

### 3. Sign in
Click **Login** in the overlay — this opens the InterviewAssist web login page
in your system browser (never inside an Electron window). After you
authenticate there, the browser redirects back to the app via a custom
`interviewassist://callback` deep link, which hands your session back to the
overlay automatically.

### 4. Add your API keys
Open **Settings** (account avatar in the title bar) and paste in your own:
- **Cerebras API key** — used for AI answers
- **Groq API key** — used for voice-to-text and screenshot analysis

Both are stored locally on your device only.

### 5. Build a Windows installer
```bash
npm run dist        # unpublished build, output in dist/
npm run release      # build + publish to GitHub Releases (auto-update)
```

---

## 🌐 Login & backend URLs

The app talks to two of your own services:
- a **web login page** (`WEB_LOGIN_URL` in `main.js`)
- a **backend auth API** (`LOGIN_API_URL` in `main.js`) that exchanges the
  deep-link token for the signed-in account

Both have hardcoded production defaults but can be overridden two ways:
1. **Env vars** — `INTERVIEWASSIST_WEB_LOGIN_URL` / `INTERVIEWASSIST_LOGIN_API_URL`, for local dev.
2. **Remote config** — at startup the app fetches `app-config.json` from the
   frontend (`{ "webLoginUrl": "...", "loginApiUrl": "..." }`). Editing that
   file updates the URLs for every installed user without a new app release.

---

## 🎤 Continuous voice recognition

Click the **🎤** button (or press **Ctrl+Shift+L**) to start listening.

- Speech is captured with a voice-activity detector, encoded to WAV, and sent to **Groq** for transcription once you pause.
- Background noise/filler phrases ("um", "thank you", "okay", …) are filtered out before being treated as a question.
- The recognized question is sent to **Cerebras** automatically and the answer streams in.

---

## 🖼️ Screenshot analysis

Press **Ctrl+Shift+S** to capture the screen and send it to Groq for analysis — useful for coding questions or slides shared during an interview.

---

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+H` | Hide / show the overlay |
| `Ctrl+Shift+M` / `Ctrl+M` | Collapse / expand the overlay |
| `Ctrl+Shift+L` | Toggle live listening (mic) |
| `Ctrl+Shift+A` | Quick ask (focus input) |
| `Ctrl+Shift+C` | Clear conversation |
| `Ctrl+Shift+S` | Analyze screen |
| `Ctrl+Shift+↑` / `↓` | Previous / next question |
| `Ctrl+Shift+1` / `0` | Jump to first / last question |
| `Ctrl+Shift+[` / `]` | Decrease / increase opacity |
| `Ctrl+Alt+Arrows` | Move the overlay window |
| `Ctrl+Enter` | Send message |

---

## 📁 Project structure

```
interviewassit-Cloude-deployement/
├── main.js                    ← Electron main process: screen hiding, hotkeys,
│                                 login/deep-link, auto-update, remote config
├── overlay.html                ← Hidden AI panel shell (loaded by main.js)
├── preload.js                  ← IPC bridge
├── renderer/
│   ├── App.js                  ← Root component
│   ├── store.js                ← App state
│   ├── components/              ← TitleBar, SettingsPanel, VoiceBar, Conversation, …
│   └── lib/                     ← cerebras.js, voice.js, screenAnalyze.js, prompts.js, …
├── package.json
└── README.md
```

---

## ⚠️ Notes

- Windows 10/11 (build 2004+) required for `WDA_EXCLUDEFROMCAPTURE`.
- Microphone permission is auto-granted by the app so listening works without a prompt.
- Requires your own Cerebras and Groq API keys (added via Settings) — no keys are bundled with the app.
- Use responsibly and ethically. Good-faith uses include mock-interview practice, live captioning/accessibility, and real-time study assistance.
