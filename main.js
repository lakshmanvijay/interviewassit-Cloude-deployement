const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, session, desktopCapturer, shell, safeStorage, powerMonitor } = require('electron');
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

// Interview settings ({ role, proficiency, mode }) fetched from
// GET /api/interview-settings/me — configured on the web app, e.g.
// { role: "Backend Developer", proficiency: "Intermediate", mode: "Candidate" }.
// Used alongside resumeText to calibrate every AI answer, see prompts.js's
// getResumeRoleContext. Same host as LOGIN_API_URL; fetch failures just
// leave this null rather than breaking login.
let interviewSettings = null;

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

// GET with a Bearer auth header, same request style as fetchBuffer/fetchJson
// above — used for every /api/*/me-style endpoint, which (unlike the
// login/resume endpoints) requires the session token as Authorization rather
// than a body. `label` is just for error messages, so a 404/500 says which
// endpoint broke rather than a bare status code — several of these often
// 404 simply because a local/dev backend doesn't have that route wired up.
function fetchJsonAuth(url, token, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, { headers: { Authorization: `Bearer ${token}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`${label || 'Request'} (${url}) returned ${res.statusCode}: ${body.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`${label || 'Request'} timed out`)));
  });
}

// All derive from the same (possibly remote-config-overridden) host as
// LOGIN_API_URL, same reasoning as get-ws-url below — never drifts out of
// sync with it.
function fetchInterviewSettings(token) {
  const api = new URL(LOGIN_API_URL);
  return fetchJsonAuth(`${api.protocol}//${api.host}/api/interview-settings/me`, token, 8000, 'Interview settings fetch');
}

// AuthResponse: { token, id, name, email, plan, credits, creditsExpireAt,
// resume, avatar, provider, joinedAt } — same shape the login POST already
// returns, but this is the dedicated read-only refresh endpoint: used to
// pick up a credits/creditsExpireAt change (e.g. after buying credits on the
// website) without forcing a full re-login.
function fetchAccountMe(token) {
  const api = new URL(LOGIN_API_URL);
  return fetchJsonAuth(`${api.protocol}//${api.host}/api/auth/me`, token, 8000, 'Account refresh');
}

// PaymentHistoryItem[]: [{ id, description, amountPaise, currency, status,
// createdAt }] — status is CREATED | PAID | FAILED.
function fetchPaymentHistory(token) {
  const api = new URL(LOGIN_API_URL);
  return fetchJsonAuth(`${api.protocol}//${api.host}/api/payments/me`, token, 8000, 'Payment history fetch');
}

// InterviewSessionResponse[] — used at login/session-restore to find an
// already-active Live Assist session (assistExpiresAt still in the future)
// so its countdown survives an app restart instead of only being known
// right after clicking "Start listening" this same run.
function fetchveSessions(token) {
  const api = new URL(LOGIN_API_URL);
  return fetchJsonAuth(`${api.protocol}//${api.host}/api/sessions/me`, token, 8000, 'Sessions fetch');
}

// POST with a JSON body + Bearer auth — same request style as
// fetchAccountFromApi above. Never rejects on a non-2xx response (unlike
// fetchJsonAuth) — resolves { ok, status, body } uniformly instead, so the
// caller can branch on `status` (e.g. 402) without try/catch gymnastics.
// True rejection is reserved for actual network/parse failures.
function postJsonAuth(url, token, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload || {});
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
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
        let parsedBody = null;
        try { parsedBody = data ? JSON.parse(data) : null; } catch (e) { parsedBody = { raw: data }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsedBody });
      });
    });
    req.write(body);
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('Session start request timed out')));
    req.end();
  });
}

// Opens (or reuses, if one's already active) a Live Assist session — spends
// 1 credit the moment a fresh one opens, buying assistExpiresAt (1 hour) of
// unmetered questions. Same host as LOGIN_API_URL. Resolves
// { ok, status, body } — status 402 specifically means "no credits", which
// the renderer surfaces distinctly (see App.js's startLiveAssistSession IPC
// handler usage) rather than as a generic error.
function startLiveAssistSession(token) {
  const api = new URL(LOGIN_API_URL);
  return postJsonAuth(`${api.protocol}//${api.host}/api/sessions/start`, token, { sessionType: 'Live Assist' }, 10000);
}

// Closes whatever Live Assist window is currently open, so idle time after
// this point isn't billed. Resolves { ok, status, body } same as start —
// status 200 means a window was actually closed (body is the now-closed
// InterviewSessionResponse), 204 means nothing was open (body is null,
// still `ok: true` since 204 is in the 2xx range — that's a legitimate
// no-op, not a failure). Called on explicit user pause/quit AND best-effort
// on system sleep / app quit (see powerMonitor + before-quit below) — the
// backend also auto-closes on WS disconnect as a safety net, but that's not
// a substitute for calling this explicitly, since the socket can stay
// connected through an idle stretch that should still stop billing.
function pauseLiveAssistSession(token) {
  const api = new URL(LOGIN_API_URL);
  return postJsonAuth(`${api.protocol}//${api.host}/api/sessions/pause`, token, {}, 10000);
}

// Starts the free 10-minute Live Assist trial — server-side gated by a
// 1-minute cooldown since the last trial actually FINISHED (not since it
// started, see endTrialSession below), so it can't be bypassed by clearing
// the renderer's localStorage copy of trialUsedAt (that copy is just for
// the countdown display). Spends no credit lot. Resolves { ok, status,
// body } same shape as the two above — status 429 means the cooldown
// hasn't elapsed yet, body.trialExpiresAt on success is when the free
// window (questions let through free by the backend) runs out.
function startTrialSession(token) {
  const api = new URL(LOGIN_API_URL);
  return postJsonAuth(`${api.protocol}//${api.host}/api/sessions/trial/start`, token, {}, 10000);
}

// Tells the backend the running free trial just finished (auto-timeout or
// an early manual quit) — see App.js's quitSession(). Anchors the
// 1-minute cooldown before the next trial to this actual completion
// moment instead of to when the trial started. Fire-and-forget from the
// caller's side (204, no meaningful body either way).
function endTrialSession(token) {
  const api = new URL(LOGIN_API_URL);
  return postJsonAuth(`${api.protocol}//${api.host}/api/sessions/trial/end`, token, {}, 10000);
}

// Posts a post-session star rating (1-5) + optional freeform message — see
// the renderer's FeedbackModal, shown from App.js's quitSession(). Same
// host as LOGIN_API_URL. Resolves { ok, status, body } same shape as the
// session endpoints above; a 400 means the rating was out of range (see
// FeedbackService on the backend).
function submitFeedback(token, payload) {
  const api = new URL(LOGIN_API_URL);
  return postJsonAuth(`${api.protocol}//${api.host}/api/feedback`, token, payload, 10000);
}

// CreditBalanceResponse: { totalMinutesAvailable, lots: [{ id, item,
// minutesGranted, minutesRemaining, purchasedAt, activatedAt, expiresAt }] }
// — the source of truth for "how much time is left" display, refreshed
// after every Activate/Pause per the backend's own guidance rather than
// relying on the AuthResponse's simpler credits/creditsExpireAt snapshot.
function fetchCreditBalance(token) {
  const api = new URL(LOGIN_API_URL);
  return fetchJsonAuth(`${api.protocol}//${api.host}/api/payments/credits`, token, 8000, 'Credit balance fetch');
}

// { name, size, contentType, url, uploadedAt } — `name` is the real
// filename the user uploaded on the web app, unlike account.resume (an
// AuthResponse field that's just a URL — its last path segment is a random
// public access token, not a filename, which is what was showing up as an
// "id" before this). 404s when no resume has been uploaded.
function fetchResumeInfo(token) {
  const api = new URL(LOGIN_API_URL);
  return fetchJsonAuth(`${api.protocol}//${api.host}/api/resumes/me`, token, 8000, 'Resume info fetch');
}

async function parseResume(url) {
  // pdf-parse's underlying pdf.js dependency prints its own noisy, non-fatal
  // warnings straight to console.warn/error while parsing (e.g. "Warning:
  // Indexing all PDF objects") — nothing we log ourselves, but still visible
  // at runtime. Silenced only for the duration of the parse call itself, and
  // always restored in `finally` even if parsing throws.
  const realWarn = console.warn, realError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    // Deferred require — only pay the require() cost when actually needed.
    // pdf-parse@1.x is a plain text extractor with no DOM/canvas dependency,
    // unlike 2.x (which wraps pdf.js and needs browser globals like
    // DOMMatrix that don't exist in Electron's bundled Node runtime).
    const pdfParse = require('pdf-parse');
    const buffer = await fetchBuffer(url);

    // Not every fetch actually returns a PDF (e.g. a JSON error body or an
    // HTML page with a 200 status instead of the file bytes) — pdf-parse's
    // own error for that case is an opaque "Invalid PDF structure" either
    // way, so this is just a quiet early-out, nothing printed.
    if (buffer.slice(0, 4).toString('latin1') !== '%PDF') return '';

    const result = await pdfParse(buffer);
    return (result.text || '').slice(0, RESUME_TEXT_MAX_CHARS);
  } catch (e) {
    return '';
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
}

// ─────────────────────────────────────────────
// CREATE THE HIDDEN OVERLAY WINDOW
// This window is visible on YOUR screen but
// EXCLUDED from any screen capture / share.
// ─────────────────────────────────────────────
// Floor below which the welcome screen's cards/rows start clipping or
// overlapping instead of just looking cozy. Applied as the BrowserWindow's
// own minWidth/minHeight below AND re-applied (capped) on every
// 'resize-overlay' call — see that handler for why: setting it once at
// construction also silently clamped the minimize/collapse button's resize
// down to COLLAPSED_HEIGHT (44px), since 44 < 480, so collapsing only ever
// shrank to this floor and stopped instead of reaching its real target.
const OVERLAY_MIN_WIDTH = 380;
const OVERLAY_MIN_HEIGHT = 480;

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 528, // 480 + ~half inch (48px @ 96dpi)
    height: 640,
    minWidth: 380,
    minHeight: 480,
    x: width - 548, // keeps the same 20px right-edge margin as before
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    // Reverted back to focusable — a non-focusable window (the earlier
    // always-on "Background mode") can never receive OS keyboard focus at
    // all, so typing into the question box literally couldn't work no
    // matter what the HTML disabled attribute said. That trade-off
    // (never-take-focus stealth vs. a working text box) isn't what's
    // wanted — typing needs to work, so this is a normal focusable window
    // again, same as before Background mode was introduced.
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

  // Lock DevTools out of packaged production builds — this is a stealth
  // overlay app, so an end user popping the inspector open (and poking at
  // the DOM/IPC/token) isn't something to allow by default the way it would
  // be in a normal app. Two layers: block the keyboard shortcuts that would
  // open it, and force-close it if it ever ends up open anyway (belt and
  // suspenders against anything else that might trigger it later). Gated on
  // app.isPackaged, not NODE_ENV, so `npm start` during development is
  // unaffected — OPEN_DEVTOOLS above still works in a packaged build too,
  // since that's an explicit opt-in, not an end user finding their own way in.
  if (app.isPackaged) {
    overlayWindow.webContents.on('before-input-event', (event, input) => {
      const key = (input.key || '').toLowerCase();
      const isF12 = key === 'f12';
      const isCtrlShiftIJ = input.control && input.shift && (key === 'i' || key === 'j' || key === 'c');
      const isCmdOptI = input.meta && input.alt && key === 'i'; // macOS equivalent
      if (isF12 || isCtrlShiftIJ || isCmdOptI) event.preventDefault();
    });
    overlayWindow.webContents.on('devtools-opened', () => {
      overlayWindow.webContents.closeDevTools();
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

// Non-null only while there's an already-active Live Assist session found
// via fetchActiveSessions at login/session-restore (assistExpiresAt still in
// the future) — lets its countdown survive an app restart. Cleared on logout.
let pendingActiveAssistExpiresAt = null;

// CreditBalanceResponse, fetched alongside the rest at login/session-restore
// so the welcome screen has real numbers immediately rather than waiting on
// the first Activate/Pause round trip. Cleared on logout.
let pendingCreditBalance = null;

// { name, size, contentType, url, uploadedAt } from GET /api/resumes/me —
// name is the real uploaded filename (see fetchResumeInfo's own comment).
// Cleared on logout. Stays null if the user never uploaded a resume (404).
let pendingResumeInfo = null;

function notifyAccountRenderer() {
  if (pendingAccount) sendToOverlay('account-received', pendingAccount);
  if (resumeText) sendToOverlay('resume-parsed', resumeText);
  if (interviewSettings) sendToOverlay('interview-settings-received', interviewSettings);
  if (pendingActiveAssistExpiresAt) sendToOverlay('active-assist-session', pendingActiveAssistExpiresAt);
  if (pendingCreditBalance) sendToOverlay('credit-balance-received', pendingCreditBalance);
  if (pendingResumeInfo) sendToOverlay('resume-info-received', pendingResumeInfo);
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

      fetchInterviewSettings(token)
        .then(settings => {
          interviewSettings = (settings && (settings.role || settings.proficiency || settings.mode)) ? settings : null;
          if (interviewSettings) sendToOverlay('interview-settings-received', interviewSettings);
        })
        .catch(e => console.error('[interview-settings] fetch failed:', e.message));

      fetchActiveSessions(token)
        .then(sessions => {
          const active = (sessions || []).find(s =>
            s.sessionType === 'Live Assist' && s.assistExpiresAt && new Date(s.assistExpiresAt).getTime() > Date.now()
          );
          pendingActiveAssistExpiresAt = active ? active.assistExpiresAt : null;
          if (pendingActiveAssistExpiresAt) sendToOverlay('active-assist-session', pendingActiveAssistExpiresAt);
        })
        .catch(e => console.error('[sessions] fetch failed:', e.message));

      fetchCreditBalance(token)
        .then(balance => {
          pendingCreditBalance = balance;
          sendToOverlay('credit-balance-received', balance);
        })
        .catch(e => console.error('[payments] credit balance fetch failed:', e.message));

      fetchResumeInfo(token)
        .then(resume => {
          pendingResumeInfo = resume;
          sendToOverlay('resume-info-received', resume);
        })
        // 404 (no resume uploaded yet) lands here too — that's expected,
        // not worth logging as an error; pendingResumeInfo just stays null.
        .catch(() => {});
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
  // No native menu bar is used anywhere in this app (frame: false, custom
  // tray context menu instead) — removing Electron's default application
  // menu entirely also removes its built-in "Toggle Developer Tools" role,
  // which otherwise keeps its Ctrl+Shift+I/F12 accelerators live even with
  // no menu bar visible. Harmless in dev too, so this isn't gated on
  // app.isPackaged like the devtools lockdown above.
  Menu.setApplicationMenu(null);

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
  // Best-effort — see pauseLiveAssistSessionBestEffort's own comment for why
  // this can't reliably block quit to await the request, and why that's an
  // acceptable trade-off given the backend's own WS-disconnect safety net.
  pauseLiveAssistSessionBestEffort('app quit');
});

// System going to sleep — pause billing for whatever's idle during that
// stretch. The WS likely stays "connected" through a sleep (OS-dependent,
// not reliable enough to lean on), so this explicit call is the real
// mechanism here, not the disconnect-based safety net.
powerMonitor.on('suspend', () => {
  pauseLiveAssistSessionBestEffort('system suspend');
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
// Fired by the renderer (App.js) right after it finishes registering its
// ipcRenderer.on(...) listeners, not on a fixed delay — closes a real race
// with the 'did-finish-load' pushes below. did-finish-load fires as soon as
// the page's synchronous script + resources are done loading, but React's
// useEffect (where those listeners get registered) is scheduled to run
// after paint, asynchronously — so did-finish-load can and sometimes does
// win the race, meaning notifyRenderer()/notifyAccountRenderer() fire while
// nothing is listening yet. Electron's webContents.send has no queuing: a
// message sent before any listener exists for that channel is just dropped,
// not buffered. There's no separate re-fetch path for this data (unlike,
// say, credit balance, which gets refreshed after every Activate/Pause), so
// a dropped 'active-assist-session' push in particular silently stayed
// missing all the way until the next full app restart — intermittently, only
// on whichever runs lost the race. Re-sending here once listeners are
// confirmed live is safe even on the runs that DID win the race, since both
// functions only re-push whatever's already cached (idempotent no-ops if
// nothing changed).
ipcMain.on('renderer-ready', () => {
  notifyRenderer();
  notifyAccountRenderer();
});

ipcMain.on('toggle-overlay', () => toggleOverlay());

ipcMain.on('quit-app', () => app.quit());

ipcMain.on('resize-overlay', (event, { width, height }) => {
  if (overlayWindow) {
    // setSize() below is clamped by the window's minimum-size constraint —
    // see OVERLAY_MIN_WIDTH/HEIGHT's comment. Capping the minimum at
    // whatever's actually being requested (never raising it above the
    // normal floor) means collapsing to COLLAPSED_HEIGHT (44px, well under
    // 480) still reaches its real target, while expanding back to the full
    // welcome-screen size restores the normal floor exactly as before.
    overlayWindow.setMinimumSize(Math.min(width, OVERLAY_MIN_WIDTH), Math.min(height, OVERLAY_MIN_HEIGHT));
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
  interviewSettings = null;
  pendingActiveAssistExpiresAt = null;
  pendingCreditBalance = null;
  pendingResumeInfo = null;
  clearSessionToken();
  sendToOverlay('logged-out');
});

// Exposes the JWT to the renderer so it can open the interview-answers
// WebSocket directly (native browser WebSocket only exists in the renderer,
// not in this Node main process). contextIsolation is already off for this
// window, so the renderer has full main-process-equivalent access anyway —
// this doesn't cross a security boundary that isn't already crossed.
ipcMain.handle('get-session-token', () => sessionToken);

// Called from the renderer when the user clicks "Start listening" —
// opens/reuses a Live Assist session before the mic actually starts, so a
// 402 (no credits) can be caught and shown as "buy credits" right there
// instead of the mic silently starting and every question afterward failing
// mid-stream. Returns { ok, status, body } — see startLiveAssistSession's
// own comment. { ok: false, status: 0 } means it couldn't even reach the
// backend (not signed in, or a network/timeout failure) — same 3-argument
// error shape as an actual HTTP failure so the renderer only needs one
// branch to check `status`, not two different failure code paths.
ipcMain.handle('start-live-assist-session', async () => {
  if (!sessionToken) return { ok: false, status: 0, body: { message: 'Not signed in' } };
  try {
    return await startLiveAssistSession(sessionToken);
  } catch (e) {
    console.error('[sessions] start-live-assist-session failed:', e.message);
    return { ok: false, status: 0, body: { message: e.message } };
  }
});

// Pull-based counterpart to the 'active-assist-session' push above (fired on
// 'did-finish-load' / 'renderer-ready') — see App.js's 'account-received'
// handler. The push relies on the renderer already having an
// ipcRenderer.on('active-assist-session', ...) listener registered at the
// exact moment main.js decides to send; renderer-ready closed most of that
// race but didn't fully eliminate it. invoke/handle has no equivalent
// failure mode: it's a direct request/response over its own reply channel,
// so it can't be silently dropped the way a push into a not-yet-registered
// listener can. Hits the backend fresh each call rather than trusting the
// pendingActiveAssistExpiresAt cache, so it's also immune to that cache
// still being null because fetchActiveSessions hadn't resolved yet.
ipcMain.handle('get-active-assist-session', async () => {
  if (!sessionToken) return null;
  try {
    const sessions = await fetchActiveSessions(sessionToken);
    const active = (sessions || []).find(s =>
      s.sessionType === 'Live Assist' && s.assistExpiresAt && new Date(s.assistExpiresAt).getTime() > Date.now()
    );
    return active ? active.assistExpiresAt : null;
  } catch (e) {
    console.error('[sessions] get-active-assist-session failed:', e.message);
    return null;
  }
});

// Called from the renderer on explicit pause/quit (see App.js's
// quitSession()). Also invoked internally (not via IPC) on system sleep and
// app quit — see pauseLiveAssistSessionBestEffort below.
ipcMain.handle('pause-live-assist-session', async () => {
  if (!sessionToken) return { ok: false, status: 0, body: { message: 'Not signed in' } };
  try {
    return await pauseLiveAssistSession(sessionToken);
  } catch (e) {
    console.error('[sessions] pause-live-assist-session failed:', e.message);
    return { ok: false, status: 0, body: { message: e.message } };
  }
});

// Called from the renderer's "10-minute free trial" button (see App.js's
// startTrial()). Same { ok, status, body } shape as the two handlers above
// — status 429 means the 1-minute cooldown hasn't elapsed since the last
// trial finished (checked server-side, so it can't be bypassed by clearing
// localStorage), body.trialExpiresAt on success is when the free window
// closes.
ipcMain.handle('start-trial-session', async () => {
  if (!sessionToken) return { ok: false, status: 0, body: { message: 'Not signed in' } };
  try {
    return await startTrialSession(sessionToken);
  } catch (e) {
    console.error('[sessions] start-trial-session failed:', e.message);
    return { ok: false, status: 0, body: { message: e.message } };
  }
});

// Called from the renderer's quitSession() when a free trial was running —
// tells the backend the trial just finished, right now, so its 1-minute
// cooldown counts from this moment rather than from when the trial started.
// See App.js's quitSession() and endTrialSession() above.
ipcMain.handle('end-trial-session', async () => {
  if (!sessionToken) return { ok: false, status: 0, body: { message: 'Not signed in' } };
  try {
    return await endTrialSession(sessionToken);
  } catch (e) {
    console.error('[sessions] end-trial-session failed:', e.message);
    return { ok: false, status: 0, body: { message: e.message } };
  }
});

// Called from FeedbackModal's submit() — { rating, message }.
ipcMain.handle('submit-feedback', async (event, payload) => {
  if (!sessionToken) return { ok: false, status: 0, body: { message: 'Not signed in' } };
  try {
    return await submitFeedback(sessionToken, payload);
  } catch (e) {
    console.error('[feedback] submit-feedback failed:', e.message);
    return { ok: false, status: 0, body: { message: e.message } };
  }
});

// Fire-and-forget pause used from non-IPC call sites (system sleep, app
// quit) where nothing is waiting on a renderer round trip — those moments
// don't have a live IPC caller to return a result to, so this just logs.
function pauseLiveAssistSessionBestEffort(reason) {
  if (!sessionToken) return;
  pauseLiveAssistSession(sessionToken)
    .then(result => console.log(`[sessions] best-effort pause (${reason}):`, result.status))
    .catch(e => console.error(`[sessions] best-effort pause (${reason}) failed:`, e.message));
}

ipcMain.handle('get-credit-balance', async () => {
  if (!sessionToken) return { ok: false, message: 'Not signed in' };
  try {
    const balance = await fetchCreditBalance(sessionToken);
    return { ok: true, balance };
  } catch (e) {
    console.error('[payments] credit balance fetch failed:', e.message);
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('get-resume-info', async () => {
  if (!sessionToken) return { ok: false, message: 'Not signed in' };
  try {
    const resume = await fetchResumeInfo(sessionToken);
    return { ok: true, resume }; // resume.name is the real filename
  } catch (e) {
    // A 404 (no resume uploaded) lands here too, same as any other failure —
    // EmptyState.js already falls back to "Not uploaded" when resumeInfo is
    // absent, so this doesn't need to distinguish "genuinely failed" from
    // "just doesn't have one yet".
    return { ok: false, message: e.message };
  }
});

// Re-fetches the account (GET /api/auth/me) so the renderer can pick up a
// fresh credits/creditsExpireAt after the user buys credits on the website
// (an external browser purchase this app has no other way to know about)
// without forcing a full re-login. Updates pendingAccount + re-sends
// 'account-received' itself, and also returns the result directly so a
// caller awaiting the invoke() doesn't have to wait on a separate event.
ipcMain.handle('refresh-account', async () => {
  if (!sessionToken) return { ok: false, message: 'Not signed in' };
  try {
    const account = await fetchAccountMe(sessionToken);
    pendingAccount = account;
    sendToOverlay('account-received', account);
    return { ok: true, account };
  } catch (e) {
    console.error('[account] refresh failed:', e.message);
    return { ok: false, message: e.message };
  }
});

// GET /api/payments/me — PaymentHistoryItem[], for the purchase-history view.
ipcMain.handle('get-payment-history', async () => {
  if (!sessionToken) return { ok: false, message: 'Not signed in' };
  try {
    const history = await fetchPaymentHistory(sessionToken);
    return { ok: true, history };
  } catch (e) {
    console.error('[payments] history fetch failed:', e.message);
    return { ok: false, message: e.message };
  }
});

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

