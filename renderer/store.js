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
  // Local-only 10-minute free trial (no backend session, no credit spend) —
  // ms timestamp of when the last trial was started, persisted across app
  // restarts so the 1-hour cooldown can't be bypassed by just reopening the
  // app. See App.js's startTrial()/quitSession() and EmptyState.js's trial
  // button. 0 = never used.
  trialUsedAt: Number(localStorage.getItem('vijayamai_trialUsedAt')) || 0,
  updateReady: false,  // true once a downloaded update is waiting to install
  updateVersion: '',
});

module.exports = { createStore, store };
