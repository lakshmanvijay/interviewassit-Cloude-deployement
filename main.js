const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, session, desktopCapturer, shell, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// ── CRASH RESILIENCE ───────────────────────────────
// There's exactly one main process for the whole app — an uncaught
// exception ANYWHERE in it (a stray IPC send to a disposed frame, a bad
// network callback, anything) otherwise takes the entire app down
// silently, including the tray icon. For a background/tray app that's
// supposed to keep running, logging and continuing is the right default —
// the alternative (crashing) is strictly worse for every error class this
// app actually throws today. electron-log's file transport still hasn't
// been configured yet at this point (that happens in setupAutoUpdater()),
// so console.error is the only sink available this early — it'll show up
// in main.log too once a packaged app's default console transport kicks in.
process.on('uncaughtException', err => {
  console.error('[fatal] uncaught exception (app kept running):', err);
});
process.on('unhandledRejection', reason => {
  console.error('[fatal] unhandled promise rejection (app kept running):', reason);
});

// ── AUTO-UPDATE (Chrome/Discord-style — silent background download, no
// native dialog; only a renderer-side banner once an update is ready) ──
// electron-updater no-ops/errors on an unpackaged `electron .` dev run, so
// this only ever runs inside app.whenReady() guarded by app.isPackaged.
const AUTO_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Set once an update finishes downloading. Kept outside setupAutoUpdater so
// notifyRenderer() can re-send it whenever a fresh overlayWindow finishes
// loading, instead of relying on the 'update-downloaded' event firing at
// the one moment a live, loaded overlayWindow happens to exist.
let pendingUpdateVersion = null;

function notifyRenderer() {
  if (pendingUpdateVersion && overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.webContents.isDestroyed() && !overlayWindow.webContents.isLoading()) {
    sendToOverlay('update-ready', { version: pendingUpdateVersion });
  }
}

function setupAutoUpdater() {
  // A packaged app has no console — route logs to a file so update failures
  // are actually diagnosable. Written to
  // %APPDATA%/<AppName>/logs/main.log on Windows.
  log.transports.file.level = 'debug';
  log.transports.console.level = 'debug';
  autoUpdater.logger = log;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('[update] checking for update');
  });
  autoUpdater.on('update-available', info => {
    log.info('[update] available:', info.version);
  });
  autoUpdater.on('update-not-available', info => {
    log.info('[update] none available, current:', info && info.version);
  });
  autoUpdater.on('download-progress', progress => {
    log.debug(`[update] downloading: ${Math.round(progress.percent)}%`);
  });
  autoUpdater.on('update-downloaded', info => {
    log.info('[update] downloaded:', info.version);
    pendingUpdateVersion = info.version;
    notifyRenderer();
  });
  autoUpdater.on('error', err => {
    // Background check failures are never surfaced to the user — same as
    // how a browser silently retries later instead of showing an error.
    log.error('[update] error:', err);
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

// No API keys live in this app anymore — chat, vision, and STT all go
// through the backend over WebSocket (/ws/interview, /ws/stt), which holds
// its own server-side provider keys.

let overlayWindow = null;
let tray = null;
let isOverlayVisible = true;
// Set true only once a real quit is actually underway (see 'before-quit'
// below) — lets the window's own 'close' handler tell an OS-level close
// signal (Alt+F4, etc.) apart from an intentional app.quit() call.
let isQuitting = false;

// Every call site that pings the renderer used to just check `if
// (overlayWindow)` — but that only proves the JS reference is non-null, not
// that the underlying native window/webContents hasn't already been torn
// down (a real gap: global shortcuts and post-await callbacks can fire in
// that exact window, e.g. right as the app is quitting). The isDestroyed()
// checks catch most of that, but Electron has a known extra edge case:
// webContents.isDestroyed() can still report false for a brief window
// while the internal render frame itself is already gone, throwing
// "Render frame was disposed before WebFrameMain could be accessed" —
// an uncaught exception here crashes the entire main process (there's
// only one, for the whole app), which is almost certainly what's been
// causing the app to close itself unexpectedly. The try/catch is the
// actual guarantee; the isDestroyed() checks are just the fast path that
// avoids the (logged, harmless) exception in the common case.
function sendToOverlay(channel, ...args) {
  if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.webContents.isDestroyed()) return;
  try {
    overlayWindow.webContents.send(channel, ...args);
  } catch (e) {
    log.warn('[sendToOverlay] send failed, window frame likely disposed:', e.message);
  }
}

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

// ── SESSION PERSISTENCE ────────────────────────────
// Without this, sessionToken only ever lived in memory — every restart
// wiped it, forcing the full browser login dance again. Persisted encrypted
// via safeStorage (OS-level: DPAPI on Windows) so the token never sits on
// disk in plaintext; if encryption isn't available on this machine, the
// session just isn't persisted (fails safe — requires login again — rather
// than falling back to storing it unencrypted).
const SESSION_FILE = path.join(app.getPath('userData'), 'session.dat');

function saveSessionToken(token) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(SESSION_FILE, safeStorage.encryptString(token));
  } catch (e) {
    console.error('[session] failed to persist token:', e.message);
  }
}

function loadSessionToken() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(SESSION_FILE)) return null;
    return safeStorage.decryptString(fs.readFileSync(SESSION_FILE));
  } catch (e) {
    console.error('[session] failed to load persisted token:', e.message);
    return null;
  }
}

function clearSessionToken() {
  try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
}

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
const RESUME_TEXT_MAX_CHARS = 8000;
let resumeText = '';

// Plain http/https GET into a Buffer — same raw-request style already used
// elsewhere in this file (the login API).
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
    // Deferred require — only pay the require() cost when actually needed.
    // pdf-parse@1.x is a plain text extractor with no DOM/canvas dependency,
    // unlike 2.x (which wraps pdf.js and needs browser globals like
    // DOMMatrix that don't exist in Electron's bundled Node runtime).
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
    width: 528, // 480 + ~half inch (48px @ 96dpi)
    height: 640,
    x: width - 548, // keeps the same 20px right-edge margin as before
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
  overlayWindow.webContents.on('did-finish-load', notifyRenderer);
  overlayWindow.webContents.on('did-finish-load', notifyAccountRenderer);
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

  // Alt+F4 (or any other OS-level close signal) sends a 'close' event
  // straight to this window, bypassing app.quit() entirely — previously
  // that fell through to 'window-all-closed' and silently killed the
  // whole app, including the tray icon. Intercept it and just hide instead,
  // same as the taskbar/tray "Toggle Overlay" behavior — unless a real
  // quit is already underway (tray Quit, the titlebar's Close button,
  // auto-update's quitAndInstall), in which case let it actually close.
  overlayWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      overlayWindow.hide();
      isOverlayVisible = false;
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  // Block native minimize — with skipTaskbar:true the window would disappear
  // with no way to restore. Redirect to our custom collapse instead.
  overlayWindow.on('minimize', () => {
    overlayWindow.restore();
    sendToOverlay('toggle-collapse');
  });
}

// Set once an account is successfully fetched (fresh login or a restored
// session) so it can be re-sent whenever a fresh overlayWindow finishes
// loading — the fetch can easily resolve before the renderer's IPC
// listeners exist yet, same reasoning as pendingUpdateVersion/
// notifyRenderer above.
let pendingAccount = null;

function notifyAccountRenderer() {
  if (pendingAccount) sendToOverlay('account-received', pendingAccount);
  if (resumeText) sendToOverlay('resume-parsed', resumeText);
}

// Shared by both the deep-link login flow and the startup session-restore
// below — given a token, validates it against the backend and populates
// the renderer with the account either way.
function activateSession(token) {
  sessionToken = token;
  saveSessionToken(token);

  fetchAccountFromApi(token)
    .then(account => {
      if (!account) return;
      pendingAccount = account;
      notifyAccountRenderer();

      if (account.resume) {
        parseResume(account.resume).then(text => {
          resumeText = text;
          if (text) sendToOverlay('resume-parsed', text);
        });
      }
    })
    .catch(e => {
      console.error('[login] failed to fetch account from API:', e.message);
      // Only a real "this token is no good" response should drop the
      // persisted session — a transient network error (offline at
      // startup, backend hiccup) shouldn't sign the user out, just fail
      // silently this once and retry on next launch.
      if (/Login API returned 40[13]/.test(e.message)) {
        sessionToken = null;
        clearSessionToken();
      }
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
  activateSession(token);
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

  tray.setToolTip('VijayamAI — Hidden from screen share');
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

  // Restore a previous session instead of forcing the user through the
  // browser login flow on every single launch — kicked off here so the
  // network round-trip overlaps with the window still loading; the account
  // gets delivered via notifyAccountRenderer() on did-finish-load either
  // way, so it doesn't matter which finishes first.
  const savedToken = loadSessionToken();
  if (savedToken) activateSession(savedToken);

  // Cold launch via the deep link on Windows/Linux (not already running,
  // so there's no 'second-instance' event) — the URL arrives as an argv.
  const launchUrl = process.argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
  if (launchUrl) handleAuthCallback(launchUrl);

  // Ctrl+M — intercept native minimize, redirect to custom collapse
  globalShortcut.register('CommandOrControl+M', () => {
    if (overlayWindow) {
      if (!isOverlayVisible) toggleOverlay();
      sendToOverlay('toggle-collapse');
    }
  });

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    toggleOverlay();
  });

  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (overlayWindow && isOverlayVisible) {
      overlayWindow.focus();
      sendToOverlay('focus-input');
    } else if (!isOverlayVisible) {
      toggleOverlay();
      setTimeout(() => {
        if (overlayWindow) overlayWindow.focus();
        sendToOverlay('focus-input');
      }, 100);
    }
  });

  globalShortcut.register('CommandOrControl+Shift+C', () => {
    sendToOverlay('clear-conversation');
  });

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    if (overlayWindow) {
      if (!isOverlayVisible) toggleOverlay();
      sendToOverlay('toggle-listen');
    }
  });

  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (overlayWindow) {
      if (!isOverlayVisible) toggleOverlay();
      sendToOverlay('trigger-screen-analyze');
    }
  });

  // Ctrl+Shift+M — collapse / expand
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (overlayWindow) {
      if (!isOverlayVisible) toggleOverlay();
      sendToOverlay('toggle-collapse');
    }
  });

  // Ctrl+Shift+Up / Down — navigate previous / next question
  globalShortcut.register('CommandOrControl+Shift+Up', () => {
    sendToOverlay('nav-prev-question');
  });
  globalShortcut.register('CommandOrControl+Shift+Down', () => {
    sendToOverlay('nav-next-question');
  });

  // Ctrl+Shift+1 / 0 — jump to first / last question
  globalShortcut.register('CommandOrControl+Shift+1', () => {
    sendToOverlay('jump-to-first-question');
  });
  globalShortcut.register('CommandOrControl+Shift+0', () => {
    sendToOverlay('jump-to-last-question');
  });

  // Ctrl+Shift+[ / ] — opacity down / up
  globalShortcut.register('CommandOrControl+Shift+[', () => {
    sendToOverlay('opacity-step', -10);
  });
  globalShortcut.register('CommandOrControl+Shift+]', () => {
    sendToOverlay('opacity-step', +10);
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
    const [w] = overlayWindow.getSize();
    overlayWindow.setPosition(Math.min(sw - w, x + MOVE_STEP), y);
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

// Fires for every real quit path (tray Quit, the titlebar Close button,
// quitAndInstall during auto-update) before any window actually closes —
// this is what lets overlayWindow's own 'close' handler above tell an
// intentional quit apart from an OS-level close signal (Alt+F4) that
// bypasses app.quit() entirely.
app.on('before-quit', () => {
  isQuitting = true;
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

ipcMain.on('quit-app', () => app.quit());

ipcMain.on('resize-overlay', (event, { width, height }) => {
  if (overlayWindow) {
    overlayWindow.setSize(width, height);
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
  pendingAccount = null;
  resumeText = '';
  clearSessionToken();
  sendToOverlay('logged-out');
});

// Exposes the JWT to the renderer so it can open the interview-answers
// WebSocket directly (native browser WebSocket only exists in the renderer,
// not in this Node main process). contextIsolation is already off for this
// window, so the renderer has full main-process-equivalent access anyway —
// this doesn't cross a security boundary that isn't already crossed.
ipcMain.handle('get-session-token', () => sessionToken);

// Derives the WS endpoint from the same (possibly remote-config-overridden)
// host as LOGIN_API_URL, so it never drifts out of sync with it.
// `path` defaults to the interview-answers socket; pass '/ws/stt' for the
// live speech-to-text socket — same host, same auth, different route.
ipcMain.handle('get-ws-url', (event, path) => {
  try {
    const api = new URL(LOGIN_API_URL);
    const scheme = api.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${api.host}${path || '/ws/interview'}`;
  } catch (e) {
    return null;
  }
});

ipcMain.on('restart-and-install', () => {
  log.info('[update] user requested restart-and-install, version:', pendingUpdateVersion);
  // setImmediate defers past the current event-loop tick so this doesn't
  // race whatever triggered it (e.g. a renderer IPC send mid-flight).
  // quitAndInstall(isSilent=true, isForceRunAfter=true): run the NSIS
  // installer with /S (fully silent — no install wizard, no Next/Next/
  // Finish) since installs here are per-user (no perMachine in the nsis
  // config, so no UAC elevation is needed either), then force the app
  // back open afterward regardless of how quit() was reached.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
});

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
// CAPTURE SCREENSHOT — returns base64 JPEG to renderer
// ─────────────────────────────────────────────
ipcMain.handle('capture-screenshot', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      // 1280x720 instead of the old 1920x1080 — vision APIs tokenize images
      // by tiling them (~512px tiles), so this roughly halves the tile
      // count (and token cost) per screenshot while staying sharp enough
      // to read on-screen text/code. Needed headroom for multiple
      // screenshots in one request without hitting the backend provider's
      // token-per-minute limit.
      thumbnailSize: { width: 1280, height: 720 }
    });
    if (!sources || !sources.length) return { error: 'No screen source' };
    // Quality 70 (was 88) — cuts payload size further; tile-based token
    // cost is driven by resolution not JPEG quality, so this mainly saves
    // upload bandwidth, but every byte helps and text stays legible.
    return { base64: sources[0].thumbnail.toJPEG(70).toString('base64') };
  } catch (err) {
    return { error: err.message };
  }
});

// Screenshot analysis moved off a direct IPC handler here — the renderer
// now sends captured screenshots straight to the backend over the same
// /ws/interview socket used for text chat (see renderer/lib/screenAnalyze.js
// + interviewSocket.js's askBackend `images` param), so it shares the
// backend's own provider key instead of needing one configured in this
// Electron process.

