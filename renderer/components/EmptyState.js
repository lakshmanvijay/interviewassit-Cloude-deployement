const { ipcRenderer, shell } = require('electron');
const { html } = require('../html');
const { useState, useEffect } = require('preact/hooks');
const { useStoreSlice } = require('../hooks');

// Ticks store.assistExpiresAt (an ISO timestamp — InterviewSessionResponse's
// assistExpiresAt, set once POST /api/sessions/start succeeds, see
// startListening() below) down into an "Xh Ym left" label. null/past means
// no active window, so the credits-only view shows instead.
function useAssistCountdown(store) {
  const expiresAtRaw = useStoreSlice(store, s => s.assistExpiresAt);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000); // 30s is plenty for a minutes-granularity countdown
    return () => clearInterval(t);
  }, []);

  if (!expiresAtRaw) return null;
  const expiresAt = new Date(expiresAtRaw).getTime();
  if (!expiresAt || expiresAt <= now) return null;

  const msLeft = expiresAt - now;
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  return { h, m, label: `${h}h ${m}m` };
}

const TRIAL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Ticks store.trialUsedAt (see startTrial() in App.js) down into cooldown
// eligibility. trialUsedAt is persisted to localStorage there, so this
// cooldown survives an app restart, not just a re-render.
function useTrialCooldown(store) {
  const trialUsedAt = useStoreSlice(store, s => s.trialUsedAt);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const readyAt = trialUsedAt ? trialUsedAt + TRIAL_COOLDOWN_MS : 0;
  if (now >= readyAt) return { eligible: true, remainingLabel: null };

  const minsLeft = Math.ceil((readyAt - now) / 60000);
  const h = Math.floor(minsLeft / 60);
  const m = minsLeft % 60;
  return { eligible: false, remainingLabel: h > 0 ? `${h}h ${m}m` : `${m}m` };
}

// CreditBalanceResponse: { totalMinutesAvailable, lots: [{ id, item,
// minutesGranted, minutesRemaining, purchasedAt, activatedAt, expiresAt }] }
// — the source of truth for balance display (see App.js's
// 'credit-balance-received' listener and quitSession()), refreshed after
// every Activate/Pause rather than trusting the AuthResponse's simpler
// credits/creditsExpireAt snapshot from login time.
function hasNoCredits(creditBalance) {
  return !creditBalance || !(creditBalance.totalMinutesAvailable > 0);
}

function daysUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 86400000) : 0;
}

// A balance can span several lots, each with its own expiry — the single
// most relevant date to show is whichever still-usable lot runs out first.
function soonestExpiryDays(creditBalance) {
  if (!creditBalance || !Array.isArray(creditBalance.lots)) return null;
  const active = creditBalance.lots.filter(l => l.minutesRemaining > 0 && l.expiresAt);
  if (!active.length) return null;
  const soonest = active.reduce((a, b) => (new Date(a.expiresAt) < new Date(b.expiresAt) ? a : b));
  return daysUntil(soonest.expiresAt);
}

function formatMinutes(mins) {
  const total = mins || 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${total} min`;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
}

function EmptyState({ store, onToggleListen, onStartTrial }) {
  const account           = useStoreSlice(store, s => s.account);
  const sessionStarted    = useStoreSlice(store, s => s.sessionStarted);
  const startingSession   = useStoreSlice(store, s => s.startingSession);
  const sessionStartError = useStoreSlice(store, s => s.sessionStartError);
  const interviewSettings = useStoreSlice(store, s => s.interviewSettings);
  const proficiencyLevel  = useStoreSlice(store, s => s.proficiencyLevel);
  const creditBalance     = useStoreSlice(store, s => s.creditBalance);
  const resumeInfo        = useStoreSlice(store, s => s.resumeInfo);
  const assist = useAssistCountdown(store);
  const trial = useTrialCooldown(store);
  const noCredits = hasNoCredits(creditBalance);
  const expiresInDays = soonestExpiryDays(creditBalance);
  const minutesAvailable = creditBalance ? creditBalance.totalMinutesAvailable : 0;

  // Transient UI navigation, not app state — doesn't need to survive a
  // remount or be visible to other components, so plain local state rather
  // than the store.
  const [showSetup, setShowSetup] = useState(false);

  // resumeInfo.name is the real uploaded filename (from GET
  // /api/resumes/me) — account.resume is just a URL whose last path segment
  // is a random public access token, not a filename, which is what used to
  // show up here instead of something readable.
  const resumeName  = resumeInfo && resumeInfo.name;
  const answerStyle = (interviewSettings && interviewSettings.mode) || null;
  const fluency     = (interviewSettings && interviewSettings.proficiency) || capitalize(proficiencyLevel);
  const allSet      = !!resumeName;

  // Opens (or reuses) a Live Assist session via POST /api/sessions/start
  // before the mic actually starts — this is where the 1 credit is spent
  // and assistExpiresAt (the 1-hour window) comes from. A 402 here means no
  // credits: surfaced distinctly (sessionStartError = 'no-credits') so the
  // UI can prompt "buy credits" instead of a dead-end generic error, per
  // the backend's explicit callout that this needs distinct handling.
  async function startListening() {
    // No client-side credit pre-check anymore — the button is always
    // clickable, and the server's actual response (402 = no credits) is the
    // sole source of truth. A local "noCredits" snapshot from account data
    // can be stale/wrong (e.g. right after a purchase that hasn't refreshed
    // yet), so blocking the click on it risked disabling a button that
    // would've actually worked.
    store.setState({ sessionStartError: null, startingSession: true });
    const result = await ipcRenderer.invoke('start-live-assist-session');
    store.setState({ startingSession: false });

    if (result.status === 402) {
      store.setState({ sessionStartError: 'no-credits' });
      return;
    }
    if (!result.ok) {
      const msg = (result.body && result.body.message) || `Couldn't start session (status ${result.status})`;
      store.setState({ sessionStartError: msg });
      return;
    }

    // Response shape isn't 100% pinned down from the frontend's side — read
    // assistExpiresAt defensively whether it comes back flat on the body or
    // nested under a `session` key.
    const body = result.body || {};
    const assistExpiresAt = body.assistExpiresAt || (body.session && body.session.assistExpiresAt) || null;
    store.setState({ assistExpiresAt, sessionStarted: true });
    setShowSetup(false);
    if (onToggleListen) onToggleListen();

    // Activate may have consumed minutes from the balance (or, per the
    // backend's own note, handed back an already-open window unchanged) —
    // refresh either way rather than assuming which happened.
    ipcRenderer.invoke('get-credit-balance').then(r => {
      if (r.ok) store.setState({ creditBalance: r.balance });
    });
  }

  return html`
    <div class="empty-state" id="empty-state">
      <div class="welcome-icon">⚡</div>

      ${!account ? html`
        <!-- ── LOGGED OUT ── -->
        <div class="welcome-title">Welcome to VijayamAI</div>
        <div class="welcome-sub">Your real-time interview copilot.</div>
        <button class="cta-btn" onClick=${() => ipcRenderer.send('start-login')}>
          <span>↱</span> Sign in
        </button>
        <div class="welcome-caption">Opens your browser to sign in securely</div>
        <div class="welcome-signup">
          New here?
          <a onClick=${() => ipcRenderer.send('start-login')}>Create an account</a>
        </div>
      ` : !sessionStarted && showSetup ? html`
        <!-- ── SETUP / CONFIRM SCREEN (opened from "Start listening") ── -->
        <div class="welcome-sub setup-tagline">Listens to the interviewer and suggests answers in real time.</div>

        <div class="setup-section">
          <div class="setup-header">
            <span>SETUP</span>
            ${allSet && html`<span class="setup-allset">✓ You're all set</span>`}
          </div>
          <div class="setup-row">
            <span class="setup-check">${resumeName ? '✓' : '○'}</span>
            <span class="setup-label">Resume</span>
            <span class="setup-value">${resumeName || 'Not uploaded'}</span>
          </div>
          <div class="setup-row">
            <span class="setup-check">${answerStyle ? '✓' : '○'}</span>
            <span class="setup-label">Answer style</span>
            <span class="setup-value">${answerStyle || '—'}</span>
          </div>
          <div class="setup-row">
            <span class="setup-check">✓</span>
            <span class="setup-label">English fluency</span>
            <span class="setup-value">${fluency}</span>
          </div>
        </div>

        <div class="info-banner">👁‍🗨 This window is always hidden from screen-share and recording, in every mode.</div>

        <div class="setup-section-label">YOUR SESSION</div>

        ${sessionStartError === 'no-credits' || (noCredits && !assist) ? html`
          <div class="session-error no-credits">
            You're out of credits. Buy more to start a Live Assist session.
            <a onClick=${() => shell.openExternal('https://vijayamai.com/credits')}>Buy credits ↗</a>
          </div>
        ` : sessionStartError ? html`
          <div class="session-error">${sessionStartError}</div>
        ` : html`
          <button class="session-card" disabled=${startingSession} onClick=${startListening}>
            <div class="session-card-main">
              <span class="session-card-title">${startingSession ? 'Starting…' : 'Continue'}</span>
              ${assist && html`<span class="session-card-badge">ACTIVE</span>`}
            </div>
            <div class="session-card-sub">
              ${assist ? `Your session is live — ${assist.label} left.` : 'Starts a new 1-hour session.'}
            </div>
            <span class="session-card-credit">✓ ${assist ? 'No credit used' : 'Uses 1 credit'}</span>
          </button>
        `}

        ${!assist && html`
          <button class="trial-btn" disabled=${!trial.eligible} onClick=${onStartTrial}>
            <span>🎁</span> ${trial.eligible ? '10-minute free trial' : `Free trial available in ${trial.remainingLabel}`}
          </button>
        `}

        <a class="setup-back" onClick=${() => setShowSetup(false)}>‹ Back</a>
      ` : !sessionStarted ? html`
        <!-- ── LOGGED IN, PRE-SESSION ── -->
        <div class="welcome-title">Welcome back, ${account.name}</div>
        <div class="welcome-sub">
          ${assist ? 'Your session is live. Jump back in whenever you like.' : 'Ready when you are.'}
        </div>

        ${assist && html`
          <div class="pass-card">
            <div class="pass-card-row">
              <span class="pass-dot"></span> ACTIVE SESSION
            </div>
            <div class="pass-timer">${assist.label} <span>left</span></div>
            <div class="pass-note">✓ No extra credit needed until this window ends.</div>
          </div>
        `}

        <div class="credits-row">
          <span>
            ◈ ${formatMinutes(minutesAvailable)} available
            ${!noCredits && expiresInDays != null ? html` · expires in ${expiresInDays}d` : ''}
          </span>
          <a onClick=${() => shell.openExternal('https://vijayamai.com/credits')}>Get credits ↗</a>
        </div>
        <div class="credits-row">
          <a onClick=${() => store.setState({ paymentHistoryOpen: true })}>◈ Purchase history</a>
        </div>

        <button class="cta-btn" onClick=${() => { store.setState({ sessionStartError: null }); setShowSetup(true); }}>
          <span>🎤</span> Start listening
        </button>
        <div class="welcome-caption">
          ${assist ? 'Continue your active session.' : noCredits ? 'No credits available — get more to continue.' : 'Spends 1 credit — buys a 1-hour window.'}
        </div>
      ` : html`
        <!-- ── SESSION ACTIVE — capture already starts automatically
             (startListening()/startTrial() both call onToggleListen()), so
             there's no "hit the mic" instruction needed here anymore. ── -->
        <div class="empty-text">Ready.</div>
      `}

      ${account && html`
        <button class="login-btn logout-btn" onClick=${() => ipcRenderer.send('logout')}>Logout</button>
      `}
    </div>
  `;
}

module.exports = { EmptyState };
