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
  account: null,   // { id, name, email, provider, avatar, plan, joinedAt, resume } once received from the web app's login, or null
  resumeText: '',  // extracted resume text, used to ground personal/background questions
  interviewSettings: null,  // { role, proficiency, mode } from GET /api/interview-settings/me — used to calibrate every answer, see lib/prompts.js
  updateReady: false,  // true once a downloaded update is waiting to install
  updateVersion: '',
});

module.exports = { createStore, store };
