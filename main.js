const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, session, desktopCapturer, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// ── AUTO-UPDATE (Chrome/Discord-style — silent background download, no
// native dialog; only a renderer-side banner once an update is ready) ──
// electron-updater no-ops/errors on an unpackaged `electron .` dev run, so
// this only ever runs inside app.whenReady() guarded by app.isPackaged.
const AUTO_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', info => {
    if (overlayWindow) overlayWindow.webContents.send('update-ready', { version: info.version });
  });
  autoUpdater.on('error', err => {
    // Background check failures are never surfaced to the user — same as
    // how a browser silently retries later instead of showing an error.
    console.error('[update] error:', err.message);
  });

  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), AUTO_UPDATE_CHECK_INTERVAL_MS);
}

// ── DEEP-LINK PROTOCOL REGISTRATION ───────────────
// Must happen before app.whenReady() — this is what lets the OS hand
// myapp://callback?token=... URLs back to this app after the system
// browser finishes the web login.
const PROTOCOL = 'interviewassist';
if (process.defaultApp) {
  // Running unpackaged (e.g. `electron .`) — needs the exact exec path + script arg.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Windows/Linux deliver the deep link as an argv on a new launch — since the
// OS would otherwise just spawn a second copy of the app, claim a single
// instance lock and forward the URL to the already-running instance instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    if (overlayWindow) {
      if (overlayWindow.isMinimized()) overlayWindow.restore();
      overlayWindow.focus();
    }
    const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`));
    if (url) handleAuthCallback(url);
  });
}

// macOS delivers deep links via this event instead of argv.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleAuthCallback(url);
});

// ── API KEYS ──────────────────────────────────────
// User-supplied via the renderer's settings dropdown (see 'set-api-keys'
// below) take priority; env vars are just a fallback for local dev.
let CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || '';
let GROQ_API_KEY     = process.env.GROQ_API_KEY || '';
let cerebrasClient = null;
function getCerebrasClient() {
  if (!cerebrasClient) {
    // Deferred until the first chat request — this SDK alone takes ~300ms to
    // require(), which used to run unconditionally before the window even opened.
    const Cerebras = require('@cerebras/cerebras_cloud_sdk');
    cerebrasClient = new Cerebras({ apiKey: CEREBRAS_API_KEY });
  }
  return cerebrasClient;
}

let overlayWindow = null;
let tray = null;
let isOverlayVisible = true;

// ── LOGIN (system-browser + deep-link hand-off) ───
// "Login" opens the real web login page in the user's system browser
// (never inside an Electron window) with a redirect param pointing back at
// our custom protocol. After the user authenticates there, the browser
// redirects to interviewassist://callback?token=..., the OS hands that URL
// to this app (see the deep-link registration above), and the token is used
// to fetch the account from the backend.
let WEB_LOGIN_URL = process.env.INTERVIEWASSIST_WEB_LOGIN_URL || 'https://vijayamai.com/login';
let LOGIN_API_URL = process.env.INTERVIEWASSIST_LOGIN_API_URL || 'https://interview-backend-production-c8b5.up.railway.app/api/auth/login';
let sessionToken = null;

// ── REMOTE CONFIG ──────────────────────────────────
// Lets us repoint the login URLs for every installed user by editing a JSON
// file on the frontend, instead of shipping a new build. Explicit env vars
// (local dev override) always win over this. Fails silently to the
// hardcoded defaults above — a broken/unreachable config file must never
// block login.
const REMOTE_CONFIG_URL = 'https://vijayamai.com/app-config.json';

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`Config fetch returned ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Config fetch timed out')));
  });
}

function loadRemoteConfig() {
  fetchJson(REMOTE_CONFIG_URL, 5000)
    .then(cfg => {
      if (cfg.webLoginUrl && !process.env.INTERVIEWASSIST_WEB_LOGIN_URL) WEB_LOGIN_URL = cfg.webLoginUrl;
      if (cfg.loginApiUrl && !process.env.INTERVIEWASSIST_LOGIN_API_URL) LOGIN_API_URL = cfg.loginApiUrl;
      console.log('[config] remote config applied:', { WEB_LOGIN_URL, LOGIN_API_URL });
    })
    .catch(e => console.error('[config] remote config fetch failed, using built-in defaults:', e.message));
}
loadRemoteConfig();

// Resume text extracted from account.resume (a PDF URL), used to ground
// answers about the candidate's background/previous projects. Truncated to
// keep prompt size sane; parsing failures (non-PDF, unreachable) just leave
// this empty rather than breaking login.
const RESUME_TEXT_MAX_CHARS = 6000;
let resumeText = '';

// Plain http/https GET into a Buffer — same raw-request style already used
// elsewhere in this file (Groq calls, the login API).
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    lib.get(parsed, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Resume fetch returned ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function parseResume(url) {
  try {
    console.log(`[resume] fetching + parsing: ${url}`);
    // Deferred require — same "only pay the cost when actually needed"
    // convention used for the Cerebras SDK above. pdf-parse@1.x is a plain
    // text extractor with no DOM/canvas dependency, unlike 2.x (which wraps
    // pdf.js and needs browser globals like DOMMatrix that don't exist in
    // Electron's bundled Node runtime).
    const pdfParse = require('pdf-parse');
    const buffer = await fetchBuffer(url);
    const result = await pdfParse(buffer);
    const text = (result.text || '').slice(0, RESUME_TEXT_MAX_CHARS);
    console.log(`[resume] extracted ${text.length} chars:\n${text}`);
    return text;
  } catch (e) {
    console.error('[resume] parse failed:', e.message);
    return '';
  }
}

// ─────────────────────────────────────────────
// CREATE THE HIDDEN OVERLAY WINDOW
// This window is visible on YOUR screen but
// EXCLUDED from any screen capture / share.
// ─────────────────────────────────────────────
function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 480,
    height: 640,
    x: width - 500,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  overlayWindow.loadFile('overlay.html');
  if (process.env.OPEN_DEVTOOLS) overlayWindow.webContents.openDevTools({ mode: 'detach' });
  if (process.env.DEBUG_CONSOLE) {
    overlayWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
      console.log(`[renderer] ${message} (${sourceId}:${line})`);
    });
  }

  // WDA_EXCLUDEFROMCAPTURE = 0x00000011 — invisible in screen share / recording
  overlayWindow.setContentProtection(true);

  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWindow.setVisibleOnAllWorkspaces(true);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  // Block native minimize — with skipTaskbar:true the window would disappear
  // with no way to restore. Redirect to our custom collapse instead.
  overlayWindow.on('minimize', () => {
    overlayWindow.restore();
    overlayWindow.webContents.send('toggle-collapse');
  });
}

// Called with the raw interviewassist://callback?token=... URL, whether it
// arrived via 'open-url' (macOS), 'second-instance' (Windows/Linux, already
// running), or process.argv on a cold launch. Extracts the token and uses it
// to fetch the account from the backend.
function handleAuthCallback(rawUrl) {
  let token;
  try {
    token = new URL(rawUrl).searchParams.get('token');
  } catch (e) {
    console.error('[login] malformed callback URL:', rawUrl);
    return;
  }
  if (!token) return;

  sessionToken = token;
  fetchAccountFromApi(token)
    .then(account => {
      if (!account) return;
      if (overlayWindow) overlayWindow.webContents.send('account-received', account);

      if (account.resume) {
        parseResume(account.resume).then(text => {
          resumeText = text;
          if (text && overlayWindow) overlayWindow.webContents.send('resume-parsed', text);
        });
      }
    })
    .catch(e => console.error('[login] failed to fetch account from API:', e.message));
}

// Response shape isn't fully known — handled defensively as either
// { user: {...} } or the user object directly.
function fetchAccountFromApi(token) {
  return new Promise((resolve, reject) => {
    const url = new URL(LOGIN_API_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ token });
    console.log(`[login] POST ${url.toString()} (token: ${token.slice(0, 12)}…)`);
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        console.log(`[login] backend response (${res.statusCode}):`, data);
        try {
          fs.writeFileSync(
            path.join(app.getPath('userData'), 'login-response.json'),
            data
          );
        } catch (e) {
          console.error('[login] failed to write login-response.json:', e.message);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Login API returned ${res.statusCode}: ${data.slice(0, 500)}`));
        }
        try {
          const parsed = JSON.parse(data);
          const user = parsed.user || parsed;
          const { password, ...account } = user;
          console.log('[login] resolved account:', account);
          resolve(account);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.write(body);
    req.on('error', reject);
    req.end();
  });
}


// ─────────────────────────────────────────────
// SYSTEM TRAY
// ─────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Toggle Overlay (Ctrl+Shift+H)',
      click: () => toggleOverlay()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  ]);

  tray.setToolTip('Interview Assist — Hidden from screen share');
  tray.setContextMenu(contextMenu);
}

// ─────────────────────────────────────────────
// TOGGLE OVERLAY VISIBILITY
// ─────────────────────────────────────────────
function toggleOverlay() {
  if (!overlayWindow) return;
  if (isOverlayVisible) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
  }
  isOverlayVisible = !isOverlayVisible;
}

// APP LIFECYCLE
// ─────────────────────────────────────────────
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
      return callback(true);
    }
    callback(true);
  });

  createOverlayWindow();
  createTray();
  if (app.isPackaged) setupAutoUpdater();

  // Cold launch via the deep link on Windows/Linux (not already running,
  // so there's no 'second-instance' event) — the URL arrives as an argv.
  const launchUrl = process.argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
  if (launchUrl) handleAuthCallback(launchUrl);

  // Ctrl+M — intercept native minimize, redirect to custom collapse
  globalShortcut.register('CommandOrControl+M', () => {
    if (overlayWindow) {
      if (!isOverlayVisible) toggleOverlay();
      overlayWindow.webContents.send('toggle-collapse');
    }
  });

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    toggleOverlay();
  });

  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (overlayWindow && isOverlayVisible) {
      overlayWindow.focus();
      overlayWindow.webContents.send('focus-input');
    } else if (!isOverlayVisible) {
      toggleOverlay();
      setTimeout(() => {
        overlayWindow.focus();
        overlayWindow.webContents.send('focus-input');
      }, 100);
    }
  });

  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (overlayWindow) {
      overlayWindow.webContents.send('clear-conversation');
    }
  });

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    if (overlayWindow) {
      if (!isOverlayVisible) toggleOverlay();
      overlayWindow.webContents.send('toggle-listen');
    }
  });

  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (overlayWindow) {
      if (!isOverlayVisible) toggleOverlay();
      overlayWindow.webContents.send('trigger-screen-analyze');
    }
  });

  // Ctrl+Shift+X — copy last answer
  globalShortcut.register('CommandOrControl+Shift+X', () => {
    if (overlayWindow) overlayWindow.webContents.send('copy-answer');
  });

  // Ctrl+Shift+M — collapse / expand
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (overlayWindow) {
      if (!isOverlayVisible) toggleOverlay();
      overlayWindow.webContents.send('toggle-collapse');
    }
  });

  // Ctrl+Shift+, / . — navigate previous / next question
  globalShortcut.register('CommandOrControl+Shift+,', () => {
    if (overlayWindow) overlayWindow.webContents.send('nav-prev-question');
  });
  globalShortcut.register('CommandOrControl+Shift+.', () => {
    if (overlayWindow) overlayWindow.webContents.send('nav-next-question');
  });

  // Ctrl+Shift+1 / 0 — jump to first / last question
  globalShortcut.register('CommandOrControl+Shift+1', () => {
    if (overlayWindow) overlayWindow.webContents.send('jump-to-first-question');
  });
  globalShortcut.register('CommandOrControl+Shift+0', () => {
    if (overlayWindow) overlayWindow.webContents.send('jump-to-last-question');
  });

  // Ctrl+Shift+[ / ] — opacity down / up
  globalShortcut.register('CommandOrControl+Shift+[', () => {
    if (overlayWindow) overlayWindow.webContents.send('opacity-step', -10);
  });
  globalShortcut.register('CommandOrControl+Shift+]', () => {
    if (overlayWindow) overlayWindow.webContents.send('opacity-step', +10);
  });

  // Ctrl+Alt+Arrows — move window 60 px per press
  const MOVE_STEP = 60;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  globalShortcut.register('CommandOrControl+Alt+Left', () => {
    if (!overlayWindow) return;
    const [x, y] = overlayWindow.getPosition();
    overlayWindow.setPosition(Math.max(0, x - MOVE_STEP), y);
  });
  globalShortcut.register('CommandOrControl+Alt+Right', () => {
    if (!overlayWindow) return;
    const [x, y] = overlayWindow.getPosition();
    overlayWindow.setPosition(Math.min(sw - 480, x + MOVE_STEP), y);
  });
  globalShortcut.register('CommandOrControl+Alt+Up', () => {
    if (!overlayWindow) return;
    const [x, y] = overlayWindow.getPosition();
    overlayWindow.setPosition(x, Math.max(0, y - MOVE_STEP));
  });
  globalShortcut.register('CommandOrControl+Alt+Down', () => {
    if (!overlayWindow) return;
    const [x, y] = overlayWindow.getPosition();
    overlayWindow.setPosition(x, Math.min(sh - 100, y + MOVE_STEP));
  });

  app.on('activate', () => {
    if (!overlayWindow) createOverlayWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─────────────────────────────────────────────
// IPC HANDLERS
// ─────────────────────────────────────────────
ipcMain.on('toggle-overlay', () => toggleOverlay());

ipcMain.on('resize-overlay', (event, { width, height }) => {
  if (overlayWindow) {
    overlayWindow.setSize(width, height);
  }
});

ipcMain.on('set-opacity', (event, opacity) => {
  if (overlayWindow) overlayWindow.setOpacity(opacity);
});

// Renderer's settings dropdown pastes in the user's own keys — used for
// AI answers (Cerebras) and voice-to-text + screenshot analysis (Groq).
ipcMain.on('set-api-keys', (event, { cerebrasApiKey, groqApiKey } = {}) => {
  if (typeof cerebrasApiKey === 'string' && cerebrasApiKey !== CEREBRAS_API_KEY) {
    CEREBRAS_API_KEY = cerebrasApiKey;
    cerebrasClient = null; // force getCerebrasClient() to rebuild with the new key
  }
  if (typeof groqApiKey === 'string') {
    GROQ_API_KEY = groqApiKey;
  }
});


ipcMain.handle('get-window-position', () => {
  if (overlayWindow) return overlayWindow.getPosition();
  return [0, 0];
});

// Opens the real web login page in the user's system browser (never inside
// an Electron window) with a redirect param pointing back at our custom
// protocol — see the deep-link registration + handleAuthCallback() above.
ipcMain.on('start-login', () => {
  const url = new URL(WEB_LOGIN_URL);
  url.searchParams.set('redirect', `${PROTOCOL}://callback`);
  shell.openExternal(url.toString());
});

// No local session/cookie store to clear here anymore — login now happens
// in the user's own system browser, not an Electron-hosted window. Logging
// out of the web app itself (if desired) has to happen in that browser.
ipcMain.on('logout', () => {
  sessionToken = null;
  resumeText = '';
  if (overlayWindow) overlayWindow.webContents.send('logged-out');
});

ipcMain.on('restart-and-install', () => autoUpdater.quitAndInstall());

// Returns screen sources so the renderer can use chromeMediaSource:'desktop'
// to capture system audio (WASAPI loopback) without touching the microphone.
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (e) {
    return [];
  }
});

// ─────────────────────────────────────────────
// CEREBRAS API BRIDGE  (official SDK)
// ─────────────────────────────────────────────
ipcMain.on('cerebras-chat', async (event, { id, model, messages }) => {
  const wc = event.sender;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const client = getCerebrasClient();
    const stream = await client.chat.completions.create({
      model: model || 'llama3.1-8b',
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 900,
      temperature: 0.1,
      top_p: 1,
    }, { signal: controller.signal });

    for await (const chunk of stream) {
      clearTimeout(timeout);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta && !wc.isDestroyed()) wc.send('cerebras-chunk', { id, delta });
      // The system prompt (base instructions + resume text) is a stable,
      // byte-identical prefix across turns in the same session, so Cerebras'
      // own KV-cache reuse (same mechanism as OpenAI's automatic prompt
      // caching — no special request shape needed) kicks in on its own.
      // This just makes that reuse visible instead of invisible.
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
        console.log(`[cerebras] prompt_tokens=${chunk.usage.prompt_tokens} cached_tokens=${cached}`);
      }
    }
    if (!wc.isDestroyed()) wc.send('cerebras-done', { id });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Request timed out — try again' : err.message;
    if (!wc.isDestroyed()) wc.send('cerebras-error', { id, error: msg });
  } finally {
    clearTimeout(timeout);
  }
});

// ─────────────────────────────────────────────
// CAPTURE SCREENSHOT — returns base64 JPEG to renderer
// ─────────────────────────────────────────────
ipcMain.handle('capture-screenshot', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });
    if (!sources || !sources.length) return { error: 'No screen source' };
    return { base64: sources[0].thumbnail.toJPEG(88).toString('base64') };
  } catch (err) {
    return { error: err.message };
  }
});

// ─────────────────────────────────────────────
// SCREEN ANALYZER — Groq Vision (llama-3.2-90b)
// Renderer passes pre-captured base64 image(s) +
// optional user text. Streams answer back.
// Same Groq API key as STT — no extra key needed.
// ─────────────────────────────────────────────
ipcMain.on('screen-analyze', async (event, { id, images, text }) => {
  const wc = event.sender;
  try {
    if (!images || !images.length) throw new Error('No screenshots provided');

    // System message: sets the assistant's role clearly
    const systemMsg = {
      role: 'system',
      content:
        'You are an expert coding and technical interview assistant. ' +
        'When given a screenshot your ONLY job is: ' +
        '(1) Find the exact question, coding problem, or code visible in the image. ' +
        '(2) Provide a complete, correct answer- Keep explanations short and scannable' +
        '(3) If the image shows code with bugs, list every bug and give the fixed code. ' +
        'NEVER describe the screenshot. Just answer the question directly.\n\n' +
        'FORMATTING (mandatory for fast reading):\n' +
        '- **bold** every key term, algorithm name, pattern, and critical fact\n' +
        '- **bold** all complexity values like **O(n log n)**\n' +
        '- Use ```lang code blocks``` for all code\n' 
    };

    // User message: all images + focused instruction
    const userContent = [
      ...images.map(b64 => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' }
      })),
      {
        type: 'text',
        text: text
          ? `My question: ${text}\n\nAlso solve any coding/interview problem visible in the screenshot above.`
          : 'Read the question or coding problem shown in the screenshot and give a complete answer with code.'
      }
    ];

    const body = JSON.stringify({
      model: 'qwen/qwen3.6-27b',
      messages: [systemMsg, { role: 'user', content: userContent }],
      max_tokens: 4096,
      temperature: 0.1,
      stream: true,
      reasoning_effort: 'none' 

    });

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.groq.com',
        port: 443,
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + GROQ_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, res => {
        console.log('[Vision] HTTP status:', res.statusCode);
        let buf = '';
        let totalChars = 0;

        res.on('data', chunk => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t || t === 'data: [DONE]') continue;
            if (!t.startsWith('data: ')) {
              // Could be an error body (non-streaming 4xx)
              if (t.startsWith('{')) console.error('[Vision] API error body:', t.slice(0, 300));
              continue;
            }
            try {
              const parsed = JSON.parse(t.slice(6));
              const delta  = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                totalChars += delta.length;
                if (!wc.isDestroyed()) wc.send('screen-analyze-chunk', { id, delta });
              }
            } catch (e) {
              console.error('[Vision] SSE parse error:', e.message, t.slice(0, 80));
            }
          }
        });
        res.on('end', () => {
          console.log('[Vision] Done — total chars streamed:', totalChars);
          if (!wc.isDestroyed()) wc.send('screen-analyze-done', { id });
          resolve();
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

  } catch (err) {
    console.error('[Vision] Outer error:', err.message);
    if (!wc.isDestroyed()) wc.send('screen-analyze-error', { id, error: err.message });
  }
});

// ─────────────────────────────────────────────
// GROQ WHISPER STT — free tier at console.groq.com
// WebM → 16 kHz WAV (ffmpeg-static), then POST to
// api.groq.com/openai/v1/audio/transcriptions
// ─────────────────────────────────────────────
ipcMain.handle('stt-transcribe', async (event, { audioBuffer, mimeType }) => {
  // Renderer converts WebM→WAV using Web Audio API and sends clean WAV bytes.
  try {
    if (!audioBuffer || !audioBuffer.length) throw new Error('No audio');

    const buf      = Buffer.from(audioBuffer);
    const tag      = Date.now();
    const mime     = mimeType || 'audio/wav';
    const ext      = mime.includes('wav') ? 'wav' : mime.includes('mp3') ? 'mp3' : 'webm';
    console.log('[STT] Sending', buf.length, 'bytes (', mime, ') to Groq Whisper');

    const boundary = 'GBoundary' + tag.toString(16);
    const CRLF = '\r\n';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}whisper-large-v3-turbo${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}json${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="language"${CRLF}${CRLF}en${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="audio.${ext}"${CRLF}Content-Type: ${mime}${CRLF}${CRLF}`),
      buf,
      Buffer.from(`${CRLF}--${boundary}--${CRLF}`)
    ]);

    return await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.groq.com',
        port: 443,
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + GROQ_API_KEY,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          console.log('[STT] Groq response', res.statusCode, ':', data.slice(0, 200));
          try {
            if (res.statusCode !== 200) {
              resolve({ error: `Groq ${res.statusCode}: ${data.slice(0, 300)}` });
            } else {
              resolve({ text: JSON.parse(data).text || '' });
            }
          } catch (e) {
            resolve({ error: 'Bad JSON from Groq: ' + data.slice(0, 100) });
          }
        });
      });
      req.on('error', e => resolve({ error: e.message }));
      req.write(body);
      req.end();
    });
  } catch (err) {
    return { error: err.message };
  }
});

// ─────────────────────────────────────────────
// NVIDIA PARAKEET STT (kept for reference)
// ─────────────────────────────────────────────
ipcMain.handle('parakeet-transcribe', async (event, { audioBuffer }) => {
  try {
    if (!audioBuffer || !audioBuffer.length) throw new Error('No audio');

    const tmpDir = os.tmpdir();
    const tag = Date.now();
    const webmPath = path.join(tmpDir, `stt_${tag}.webm`);
    const wavPath  = path.join(tmpDir, `stt_${tag}.wav`);

    await writeFile(webmPath, Buffer.from(audioBuffer));

    // Convert to 16 kHz mono WAV (Parakeet works best at 16 kHz)
    await new Promise((res, rej) => {
      const ff = spawn(ffmpegPath, ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath]);
      ff.on('close', code => code === 0 ? res() : rej(new Error('ffmpeg conversion failed')));
      ff.on('error', rej);
    });

    const wavData = fs.readFileSync(wavPath);
    try { fs.unlinkSync(webmPath); } catch (e) {}
    try { fs.unlinkSync(wavPath);  } catch (e) {}

    // Build multipart/form-data body
    const boundary = 'PBoundary' + tag.toString(16);
    const CRLF = '\r\n';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}nvidia/parakeet-ctc-1.1b-asr${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="audio.wav"${CRLF}Content-Type: audio/wav${CRLF}${CRLF}`),
      wavData,
      Buffer.from(`${CRLF}--${boundary}--${CRLF}`)
    ]);

    return await new Promise((resolve) => {
      const req = https.request({
        hostname: 'integrate.api.nvidia.com',
        port: 443,
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + GROQ_API_KEY,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              resolve({ error: `Parakeet ${res.statusCode}: ${data.slice(0, 200)}` });
            } else {
              resolve({ text: JSON.parse(data).text || '' });
            }
          } catch (e) {
            resolve({ error: 'Bad response from Parakeet API' });
          }
        });
      });
      req.on('error', e => resolve({ error: e.message }));
      req.write(body);
      req.end();
    });
  } catch (err) {
    return { error: err.message };
  }
});
