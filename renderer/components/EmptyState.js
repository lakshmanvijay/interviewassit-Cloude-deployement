const { ipcRenderer, shell } = require('electron');
const { html } = require('../html');
const { useState, useEffect } = require('preact/hooks');
const { useStoreSlice, useAssistCountdown, useExpiryCountdown } = require('../hooks');

const TRIAL_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes — must match backend's TRIAL_COOLDOWN (InterviewSessionService), this is only the local display estimate

// Ticks store.trialUsedAt down into cooldown eligibility — this IS the
// "when do I get another free trial" timer, rendered live on the trial
// button below. trialUsedAt is set to the trial's actual completion time
// (not when it started — see App.js's quitSession()), persisted to
// localStorage there so this cooldown survives an app restart, not just a
// re-render. Server-side is still the actual gate (see backend's
// InterviewSessionService.startTrial/endTrial, 429 if too soon, also
// counted from completion) — this is just the matching live countdown display.
function useTrialCooldown(store) {
  const trialUsedAt = useStoreSlice(store, s => s.trialUsedAt);
  const [now, setNow] = useState(Date.now());
  const readyAt = trialUsedAt ? trialUsedAt + TRIAL_COOLDOWN_MS : 0;

  useEffect(() => {
    if (now >= readyAt) return;
    let timeoutId;
    // Same self-rescheduling trick as hooks.js's useAssistCountdown: 30s
    // ticks are plenty at first, switching to 1s once inside the last
    // minute so the seconds count down smoothly instead of jumping.
    function schedule() {
      const msLeft = readyAt - Date.now();
      const delay = msLeft <= 60000 ? 1000 : 30000;
      timeoutId = setTimeout(() => { setNow(Date.now()); schedule(); }, delay);
    }
    schedule();
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyAt]);

  if (now >= readyAt) return { eligible: true, remainingLabel: null };

  const msLeft = readyAt - now;
  if (msLeft < 60000) {
    const secsLeft = Math.max(0, Math.ceil(msLeft / 1000));
    return { eligible: false, remainingLabel: `${secsLeft}s` };
  }
  const minsLeft = Math.ceil(msLeft / 60000);
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

// A balance can span several lots, each with its own expiry — the single
// most relevant date to show is whichever still-usable lot runs out first.
function soonestActiveLot(creditBalance) {
  if (!creditBalance || !Array.isArray(creditBalance.lots)) return null;
  // activatedAt gates this to a lot whose window clock has actually started
  // (see CreditLot/CreditLotService) — a still-dormant lot (bought but never
  // used) has minutesRemaining > 0 too but no window running yet, so it
  // isn't an "active window" to show a countdown for.
  const active = creditBalance.lots.filter(l => l.minutesRemaining > 0 && l.expiresAt && l.activatedAt);
  if (!active.length) return null;
  return active.reduce((a, b) => (new Date(a.expiresAt) < new Date(b.expiresAt) ? a : b));
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

// "8/22/2026, 11:30:20 PM" — matches the web app's absolute-time display for
// the same field, shown alongside the "Xh Ym left" countdown so a user who
// glances at this later (or across a time-zone gap) sees exactly when it
// ends, not just how long was left at some earlier render.
function formatExpiry(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleString('en-US');
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
  // Raw ISO value alongside the derived countdown (assist) below — needed to
  // render the absolute "Expires 8/22/2026, 11:30:20 PM" line, which the
  // countdown hook's {h, m, label, ...} shape doesn't carry.
  const assistExpiresAt   = useStoreSlice(store, s => s.assistExpiresAt);
  const assist = useAssistCountdown(store);
  // assist (above) only reflects a currently *open* Live Assist session row
  // (store.assistExpiresAt, restored via 'active-assist-session' / the
  // get-active-assist-session pull — see App.js). But a credit lot stays
  // activated and within its window even after that session row closes
  // (pause/quit, or an app restart that never reopened one) — e.g. someone
  // who paused with 52 of their 60 minutes still unused, window still open
  // for another day. Continuing in that state reuses the same lot for free
  // (see backend's activateLiveAssist/pickLotForNewSession), so the ACTIVE
  // SESSION card below should still show — this used to depend solely on
  // `assist`, so it silently disappeared the moment the session row closed
  // even though the lot itself was still very much active, which is exactly
  // what creditBalance.lots (already reliably populated — see the
  // credits-row's own "expires in Xd" a few lines down) can tell us
  // independent of any session row.
  const activeLot = soonestActiveLot(creditBalance);
  const lotWindow = useExpiryCountdown(activeLot ? activeLot.expiresAt : null);
  // Prefer the session-based countdown when a session actually is open
  // (assist), since that one is capped at the real remaining credit budget
  // (see backend's openLiveAssistWindow); fall back to the lot's own window
  // deadline otherwise.
  const windowTimer = assist || lotWindow;
  const windowExpiresAt = assist ? assistExpiresAt : (activeLot ? activeLot.expiresAt : null);
  const trial = useTrialCooldown(store);
  const noCredits = hasNoCredits(creditBalance);
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

        <!-- Free trial is only for someone with nothing else to fall back on: hidden the moment
             they have an active paid window (assist) OR any usable credit lot at all (noCredits is
             false — see hasNoCredits(), which counts dormant/unactivated lots too, not just an
             already-open window), even if that lot hasn't been activated yet. Previously this only
             checked !assist, so a user sitting on a still-unused credit lot (bought but never
             started) could see and use the free trial anyway, which isn't the intent — the trial is
             meant strictly for users with zero credits and no active window, not a bonus on top of
             paid credits. -->
        ${!assist && noCredits && html`
          <button class="trial-btn" disabled=${!trial.eligible} onClick=${onStartTrial}>
            <span>🎁</span> ${trial.eligible ? '10-minute free trial' : `Free trial available in ${trial.remainingLabel}`}
          </button>
        `}

        <a class="setup-back" onClick=${() => setShowSetup(false)}>‹ Back</a>
      ` : !sessionStarted ? html`
        <!-- ── LOGGED IN, PRE-SESSION ── -->
        <div class="welcome-title">Welcome back, ${account.name}</div>
        <div class="welcome-sub">
          ${windowTimer ? 'Your session is live. Jump back in whenever you like.' : 'Ready when you are.'}
        </div>

        ${windowTimer && html`
          <div class="pass-card">
            <div class="pass-card-row">
              <span class="pass-dot"></span> ACTIVE SESSION
            </div>
            <div class="pass-timer ${windowTimer.critical ? 'critical' : ''}">${windowTimer.label} <span>left</span></div>
            ${formatExpiry(windowExpiresAt) && html`<div class="pass-expiry">Expires ${formatExpiry(windowExpiresAt)}</div>`}
            <!-- Same big lettering as the window countdown above (.pass-timer)
                 rather than the small credits-row text — the window
                 countdown alone doesn't tell you how much of your credit is
                 actually left to spend within it, and that's the number a
                 user glancing at this card actually wants to know at a glance. -->
            <div class="pass-timer">${formatMinutes(minutesAvailable)} <span>available</span></div>
            <div class="pass-note">✓ No extra credit needed until this window ends.</div>
          </div>
        `}

        <!-- Balance text removed from here entirely — the pass-card above
             already shows "{minutes} available" in big lettering whenever
             there's anything active to show (windowTimer), so this small-text
             repeat was pure duplication. "expires in Xd" was dropped from
             this row for the same reason a while back (see pass-card's
             formatExpiry). -->
        <div class="credits-row">
          <a onClick=${() => shell.openExternal('https://vijayamai.com/credits')}>Get credits ↗</a>
        </div>

        <button class="cta-btn" onClick=${() => { store.setState({ sessionStartError: null }); setShowSetup(true); }}>
          <span>🎤</span> Start listening
        </button>
        <div class="welcome-caption">
          ${windowTimer ? 'Continue your active session.' : noCredits ? 'No credits available — get more to continue.' : 'Spends 1 credit — buys a 1-hour window.'}
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
