// Minimal reactive store. Components subscribe to a *slice* of state via
// useStoreSlice() (see hooks.js) so a change to one field (e.g. streaming
// text on message #7) only re-renders the one component that reads it,
// instead of the whole tree re-rendering top-down like the old innerHTML
// rebuilds did.
function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  function getState() {
    return state;
  }

  function setState(patch) {
    const partial = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...partial };
    listeners.forEach(l => l(state));
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getState, setState, subscribe };
}

const store = createStore({
  mode: 'interview',
  model: 'gpt-oss-120b',
  proficiencyLevel: 'intermediate',  // 'basic' | 'intermediate' | 'advanced' — shapes answer language, see lib/prompts.js
  conversation: [],        // [{ id, role, content, streaming }]
  navIndex: -1,
  pendingScreenshots: [],
  listening: false,
  autoAsk: true,
  voiceStatus: { text: '● audio off', cls: '' },
  liveTranscript: '',
  warning: '',
  collapsed: false,
  sendDisabled: false,
  capturingScreenshot: false,
  opacity: 88,
  opacityOpen: false,  // toggled by the 👁 titlebar button — shows the opacity slider popover instead of it sitting inline all the time
  settingsOpen: false,
  account: null,   // AuthResponse: { id, name, email, plan, credits, creditsExpireAt, resume, avatar, provider, joinedAt } once received from the web app's login, or null
  resumeText: '',  // extracted resume text, used to ground personal/background questions
  interviewSettings: null,  // { role, proficiency, mode } from GET /api/interview-settings/me — used to calibrate every answer, see lib/prompts.js
  sessionStarted: false,  // set true once POST /api/sessions/start (Live Assist) succeeds — gates InputArea's visibility, see EmptyState.js/InputArea.js
  startingSession: false,  // true while that request is in flight — disables the Start listening button
  sessionStartError: null,  // null | 'no-credits' | <error message string> — see EmptyState.js's startListening()
  assistExpiresAt: null,  // ISO timestamp from InterviewSessionResponse.assistExpiresAt — drives the countdown card in EmptyState.js
  creditBalance: null,  // CreditBalanceResponse: { totalMinutesAvailable, lots: [...] } from GET /api/payments/credits — source of truth for the balance display, refreshed after every Activate/Pause. See EmptyState.js.
  resumeInfo: null,  // { name, size, contentType, url, uploadedAt } from GET /api/resumes/me — resumeInfo.name is the real uploaded filename (account.resume is just a URL whose last path segment is a random access token, not a filename). null if no resume uploaded. See EmptyState.js.
  shortcutsOpen: false,  // toggled by the ⌨ titlebar button — shows ShortcutsModal
  paymentHistoryOpen: false,  // toggled from EmptyState's "History" link — shows PaymentHistoryModal
  // 10-minute free trial (no InterviewSession row, no credit lot spent) — ms
  // timestamp of when the last trial actually FINISHED (set in App.js's
  // quitSession(), not startTrial() — the cooldown counts from completion,
  // not from when it started), persisted across app restarts purely for the
  // local countdown display. The actual cooldown is enforced server-side
  // (see App.js's quitSession(), which calls POST /api/sessions/trial/end)
  // and can't be bypassed by clearing this. See also EmptyState.js's trial
  // button. 0 = never used.
  //
  // Starts at 0 rather than reading localStorage here — `account` isn't
  // known yet at module load (it's restored later via the 'account-received'
  // IPC event), and the persisted value is keyed PER ACCOUNT (see
  // trialUsedAtKey below) precisely so that one user's trial cooldown can't
  // leak into a different account's countdown display on a shared machine
  // where more than one person signs into the same installed app. App.js's
  // 'account-received' handler re-hydrates this from the right key once the
  // account is actually known.
  trialUsedAt: 0,
  // ISO timestamp from the backend's TrialStartResponse — when the CURRENT
  // free trial's 10-minute window runs out. Not persisted (unlike
  // trialUsedAt above) since it's only meaningful while a trial is actually
  // running this session. Drives TitleBar's in-session countdown badge via
  // hooks.js's useAssistCountdown(store, 'trialExpiresAt') — assistExpiresAt
  // is never set for a trial, so without this the badge had nothing to show
  // during one. Cleared back to null in quitSession(). null = no trial running.
  trialExpiresAt: null,
  updateReady: false,  // true once a downloaded update is waiting to install
  updateVersion: '',
});

// The free-trial cooldown display (store.trialUsedAt, see above) used to be
// stored under one fixed localStorage key shared by whoever was logged into
// this installed app — so on a shared machine, User A using the trial and
// logging out would leave User B seeing (and being blocked by) User A's
// cooldown countdown the moment they signed in, even though the backend's
// own gate (User.trialStartedAt) was always correctly per-account. Keying
// by account id (falling back to email) scopes the display to match.
// Returns null if there's no account to key by yet (nothing to read/write).
function trialUsedAtKey(account) {
  const id = account && (account.id || account.email);
  return id ? `vijayamai_trialUsedAt_${id}` : null;
}

module.exports = { createStore, store, trialUsedAtKey };
