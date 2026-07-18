cha# InterviewAssist — Local AI Overlay (Ollama + Voice)

A screen-hidden assistant for Windows. **Visible on your monitor, invisible to screen-sharing tools** (Zoom, Teams, Meet, OBS). It now runs on a **local Ollama model** (no API key, nothing leaves your machine) and can **listen continuously** to spoken questions and answer them hands-free.

> Pipeline: **microphone → speech-to-text → Ollama → answer on screen**

---

## 🔒 How the screen hiding works

On Windows, Electron's `setContentProtection(true)` calls the Win32 API
`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`, which excludes the
window from any screen capture (Zoom/Teams/Meet share, OBS, Snipping Tool,
PrintScreen) while keeping it fully visible on your physical monitor.

---

## 🚀 Quick start

### 1. Install & run Ollama
Download from [ollama.com](https://ollama.com), then pull a model:
```bash
ollama pull llama3.1          # good general/interview model
# or a smaller/faster one:
ollama pull qwen2.5:3b
# or a coding-focused one:
ollama pull qwen2.5-coder:7b
```
Make sure the server is running (it usually starts automatically):
```bash
ollama serve
```
By default it listens on `http://localhost:11434`.

### 2. Install app dependencies
```bash
npm install
```

### 3. Run
```bash
npm start
```

### 4. Build a Windows installer
```bash
npm run build      # output in dist/
```

---

## 🤖 Using the local model

- The **Model** dropdown auto-fills with whatever models you've pulled. Hit **↻** to refresh.
- The **host field** at the bottom defaults to `http://localhost:11434`. Change it if Ollama runs elsewhere (e.g. another PC: `http://192.168.1.50:11434`). The green/red dot shows connection status.
- No API key. All inference is local.

**Note on connectivity:** the app talks to Ollama from Electron's *main process*
(plain Node HTTP), which sidesteps the CORS/origin restriction that blocks
browser `fetch` calls to Ollama. You do **not** need to set `OLLAMA_ORIGINS`.

---

## 🎤 Continuous voice recognition

Click the **🎤** button (or press **Ctrl+Shift+L**) to start listening.

- Live speech appears in the voice bar as it's recognized.
- When the speaker **pauses (~1.3 s)**, the finished sentence is treated as a complete question.
- With **auto** checked, that question is sent to Ollama automatically and the answer streams in.
- Uncheck **auto** to have recognized text dropped into the input box for review before sending.

### Speech engine
By default this uses the browser **Web Speech API** (`webkitSpeechRecognition`) — zero setup.

⚠️ **Important:** in some Electron builds the Web Speech API relies on a Google
backend that isn't bundled, so it may report a `network` error and not return
text. If that happens, switch to the **offline engine** below (it's also fully
local, matching the Ollama setup).

---

## 🧩 Offline STT with Vosk (recommended fallback)

Fully offline, no Google dependency, works reliably inside Electron.

**1. Install Vosk** (already listed as an optional dependency):
```bash
npm install vosk
```

**2. Download a model** from [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models),
unzip it, and place the folder next to `main.js` as `model/`
(e.g. `vosk-model-small-en-us-0.15` → rename to `model`).

**3. Replace the Web Speech engine** in `overlay.html` with this renderer-side
recognizer (it runs locally because the window has `nodeIntegration: true`):

```js
const vosk = require('vosk');
const path = require('path');
vosk.setLogLevel(-1);
const voskModel = new vosk.Model(path.join(__dirname, 'model'));

let voskRec, audioCtx, srcNode, procNode, micStream;

async function startVosk() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });
  audioCtx = new AudioContext();
  const inRate = audioCtx.sampleRate;                 // typically 48000
  voskRec   = new vosk.Recognizer({ model: voskModel, sampleRate: 16000 });
  srcNode   = audioCtx.createMediaStreamSource(micStream);
  procNode  = audioCtx.createScriptProcessor(4096, 1, 1);
  srcNode.connect(procNode);
  procNode.connect(audioCtx.destination);

  procNode.onaudioprocess = (e) => {
    const f32  = e.inputBuffer.getChannelData(0);     // Float32 @ inRate
    const i16  = downsample(f32, inRate, 16000);      // Int16Array @ 16k
    const buf  = Buffer.from(i16.buffer);
    if (voskRec.acceptWaveform(buf)) {
      const text = voskRec.result().text;
      if (text) { ask(text); }                        // → reuse existing ask()
    } else {
      updateLiveTranscript(voskRec.partialResult().partial);
    }
  };
}

function stopVosk() {
  if (procNode) procNode.disconnect();
  if (srcNode)  srcNode.disconnect();
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
}

function downsample(input, inRate, outRate) {
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
```

Then call `startVosk()` / `stopVosk()` from `toggleListen()` instead of the
Web Speech `recognition` object.

---

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+H` | Hide / show the overlay |
| `Ctrl+Shift+L` | Toggle live listening (mic) |
| `Ctrl+Shift+A` | Quick ask (focus input) |
| `Ctrl+Shift+C` | Clear conversation |
| `Ctrl+Enter`   | Send message |

---

## 🎯 Modes

- **Interview** — concise, keyword-rich answers for behavioral + technical questions.
- **Coding** — approach + code + complexity for algorithmic problems.
- **General** — general-purpose assistant.

Edit the `SYSTEM_PROMPTS` object in `overlay.html` to tune them.

---

## 📁 Project structure

```
stealth-interview-app/
├── main.js          ← Electron main process: screen hiding, hotkeys, Ollama bridge
├── overlay.html     ← Hidden AI panel + voice recognition
├── control.html     ← Mini opacity control panel
├── preload.js       ← IPC bridge
├── package.json
└── README.md
```

---

## ⚠️ Notes

- Windows 10/11 (build 2004+) required for `WDA_EXCLUDEFROMCAPTURE`.
- Microphone permission is auto-granted by the app so listening works without a prompt.
- Local models are slower than cloud APIs; pick a smaller model (e.g. `qwen2.5:3b`) for snappier answers, a larger one for quality.
- Use responsibly and ethically. Good-faith uses include mock-interview practice, live captioning/accessibility, and real-time study assistance.
