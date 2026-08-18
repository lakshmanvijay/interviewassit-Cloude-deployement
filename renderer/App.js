const { ipcRenderer } = require('electron');
const { html } = require('./html');
const { useRef, useEffect } = require('preact/hooks');

const { getSystemPrompt } = require('./lib/prompts');
const { connect: connectInterviewSocket, disconnect: disconnectInterviewSocket, askBackend, cancelQuestion, CANCELLED_ERROR } = require('./lib/interviewSocket');
const { screenAnalyze } = require('./lib/screenAnalyze');
const { createVoiceController } = require('./lib/voice');
const { createWarningController } = require('./lib/warning');
const { createQuestionNav } = require('./lib/navigation');
const { scrollElIntoTop } = require('./lib/scroll');

const { TitleBar } = require('./components/TitleBar');
const { SettingsPanel } = require('./components/SettingsPanel');
const { StatusWarning } = require('./components/StatusWarning');
const { UpdateBanner } = require('./components/UpdateBanner');
const { VoiceBar } = require('./components/VoiceBar');
const { Conversation } = require('./components/Conversation');
const { InputArea } = require('./components/InputArea');

const FULL_WIDTH = 528; // matches overlayWindow's initial width in main.js
const FULL_HEIGHT = 640;
const COLLAPSED_HEIGHT = 44;

let _idCounter = 0;
function genId() { return 'm' + (++_idCounter) + '_' + Date.now().toString(36); }

function App({ store }) {
  const conversationRef = useRef(null);
  const inputRef = useRef(null);

  const warningRef = useRef(null);
  if (!warningRef.current) warningRef.current = createWarningController(store);

  const questionNavRef = useRef(null);
  if (!questionNavRef.current) {
    questionNavRef.current = createQuestionNav(store, () => conversationRef.current);
  }

  function updateMessage(id, patch) {
    store.setState(s => ({
      conversation: s.conversation.map(m => (m.id === id ? { ...m, ...patch } : m))
    }));
  }

  // Looked up lazily (inside scrollElIntoTop's delayed callback) since the
  // message usually doesn't exist in the DOM yet at the moment this is called.
  function scrollQuestionIntoTop(userId) {
    scrollElIntoTop(() => conversationRef.current && conversationRef.current.querySelector(`[data-msg-id="${userId}"]`));
  }

  // userId -> { assistantId, askId } for every question ever asked this
  // session, kept for the lifetime of the app (not cleared per-question) so
  // a continuation (see below) can find its way back to the SAME assistant
  // bubble and in-flight backend request no matter how long ago the
  // original ask() call already returned.
  const askStateRef = useRef({});

  // `liveUserId`, if given, is an already-on-screen user message (voice.js's
  // live-recognized bubble, growing in place as the interviewer talks — see
  // createVoiceController's onTranscript wiring below) that should be
  // finalized in place rather than duplicated with a second new bubble.
  // `isContinuation` means this is a regeneration of that same question with
  // more words appended (the interviewer kept talking mid-answer) — reuses
  // the existing assistant bubble instead of adding a second one.
  async function ask(text, liveUserId, isContinuation) {
    text = (text || '').trim();
    if (!text) return;

    // Captured *before* the new/finalized user message is appended below, so
    // it holds prior turns only — the backend's WS API takes one flat
    // `question` string (no separate messages array), so recent history gets
    // folded into that string instead of duplicating the question we're
    // about to ask. Excludes the live bubble itself, since — if it exists —
    // it's already sitting in `conversation` as this exact question, not a
    // prior turn.
    const priorHistory = store.getState().conversation
      .filter(m => m.id !== liveUserId)
      .slice(-2)
      .map(m => ({ role: m.role, content: m.content }));

    const reuseLive = liveUserId && store.getState().conversation.some(m => m.id === liveUserId);
    const userId = reuseLive ? liveUserId : genId();
    if (reuseLive) {
      updateMessage(userId, { content: text });
    } else {
      store.setState(s => ({ conversation: [...s.conversation, { id: userId, role: 'user', content: text }] }));
    }
    scrollQuestionIntoTop(userId);

    const { mode, resumeText, proficiencyLevel, interviewSettings } = store.getState();
    const systemPrompt = getSystemPrompt(mode, resumeText, proficiencyLevel, interviewSettings);
    const historyText = priorHistory.length
      ? '\n\nRECENT CONVERSATION:\n' + priorHistory.map(m => `${m.role === 'user' ? 'Q' : 'A'}: ${m.content}`).join('\n')
      : '';
    const question = `${systemPrompt}${historyText}\n\nNEW QUESTION:\n${text}`;

    // A continuation reuses the SAME assistant bubble it's replacing —
    // cancelInFlight() below already reset it to empty/streaming the moment
    // the interviewer resumed talking — instead of adding a second one.
    const existing = askStateRef.current[userId];
    let assistantId;
    if (isContinuation && existing) {
      assistantId = existing.assistantId;
      updateMessage(assistantId, { content: '', streaming: true });
    } else {
      assistantId = genId();
      store.setState(s => ({ conversation: [...s.conversation, { id: assistantId, role: 'assistant', content: '', streaming: true }] }));
    }

    let lastRenderAt = 0;
    try {
      // Explicitly pinned to cerebras — it's the fast provider (500-2000+
      // tok/s on dedicated hardware vs ~20-80 tok/s for OpenAI/Anthropic).
      // Relying on the backend's default risks silently falling back to a
      // much slower provider (this has happened before — see the "No LLM
      // provider configured" incident). Remove this pin once the backend
      // default is confirmed fixed, if you'd rather not hardcode it here.
      const { id: askId, promise } = await askBackend(question, partial => {
        const now = performance.now();
        if (now - lastRenderAt < 30) return;
        lastRenderAt = now;
        updateMessage(assistantId, { content: partial });
        // Keep the question re-pinned to the top on every chunk, not just
        // once at the start — as the answer streams in and grows taller
        // below it, the browser can nudge scroll position on its own
        // (reflow/scroll-anchoring), which would otherwise let the question
        // drift down out of the top spot over the course of a long answer.
        scrollQuestionIntoTop(userId);
      }, 'cerebras');
      // Recorded so a later continuation can find this bubble/request again,
      // and so cancelInFlight() can abort this exact request by id.
      askStateRef.current[userId] = { assistantId, askId };

      const reply = await promise;
      updateMessage(assistantId, { content: reply, streaming: false });
      warningRef.current.showWarning('');
    } catch (err) {
      if (err.message === CANCELLED_ERROR) {
        // Superseded by a continuation — cancelInFlight() already reset this
        // bubble, and the continuation's own ask() call (already in flight
        // or about to be) will fill it in with the regenerated answer. No
        // error to show; this was deliberate, not a failure.
      } else {
        updateMessage(assistantId, { content: 'Error: ' + err.message, streaming: false });
        warningRef.current.showWarning(err.message);
      }
    } finally {
      scrollQuestionIntoTop(userId);
    }
  }

  // Called the instant the interviewer resumes speaking while `questionId`'s
  // answer is still generating (see voice.js's onSpeechResumed, fired from
  // its continuation-detection in vadLoop) — cancels the stale in-flight
  // backend request right away and resets its bubble back to an
  // empty/streaming state, so nothing outdated lingers on screen while the
  // fuller, combined question is captured and (re)asked.
  function cancelInFlight(questionId) {
    const state = askStateRef.current[questionId];
    if (!state) return;
    cancelQuestion(state.askId);
    updateMessage(state.assistantId, { content: '', streaming: true });
  }

  const voiceControllerRef = useRef(null);
  if (!voiceControllerRef.current) {
    voiceControllerRef.current = createVoiceController({
      store,
      showOnScreen: warningRef.current.showOnScreen,
      onSpeechResumed: questionId => cancelInFlight(questionId),
      onTranscript: async (text, liveUserId, isContinuation) => {
        if (store.getState().autoAsk) {
          await ask(text, liveUserId, isContinuation);
          return;
        }
        // Not auto-asking — the text goes into the input box instead of
        // being submitted. A brand-new live bubble was never a submitted
        // question, so it comes back out; a continuation's bubble IS a real,
        // already-asked question though, so it's left alone (autoAsk being
        // off just means the follow-up doesn't get auto-submitted).
        if (liveUserId && !isContinuation) {
          store.setState(s => ({ conversation: s.conversation.filter(m => m.id !== liveUserId) }));
        } else if (isContinuation) {
          // autoAsk was switched off in the narrow window between speech
          // resuming (which already cancelled the in-flight answer via
          // cancelInFlight) and this utterance finishing — nothing will call
          // ask() now, so that bubble would otherwise be stuck empty forever.
          const state = askStateRef.current[liveUserId];
          if (state) updateMessage(state.assistantId, { content: '_Auto-ask was turned off mid-answer — press Send to get an answer._', streaming: false });
        }
        const el = inputRef.current;
        el.value = (el.value ? el.value + ' ' : '') + text;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
      }
    });
  }

  async function askWithScreenshots(images, text) {
    const userLabel = images.length > 1
      ? `📸 ×${images.length}${text ? ' — ' + text : ''}`
      : `📸${text ? ' — ' + text : ''}`;

    const userId = genId();
    store.setState(s => ({ conversation: [...s.conversation, { id: userId, role: 'user', content: userLabel }] }));
    scrollQuestionIntoTop(userId);

    const assistantId = genId();
    store.setState(s => ({ conversation: [...s.conversation, { id: assistantId, role: 'assistant', content: '', streaming: true }] }));

    store.setState({ sendDisabled: true });
    let lastRenderAt = 0;
    try {
      const { resumeText, interviewSettings } = store.getState();
      const reply = await screenAnalyze(images, text, resumeText, interviewSettings, partial => {
        const now = performance.now();
        if (now - lastRenderAt < 30) return;
        lastRenderAt = now;
        updateMessage(assistantId, { content: partial });
        scrollQuestionIntoTop(userId);
      });
      updateMessage(assistantId, { content: reply, streaming: false });
    } catch (err) {
      updateMessage(assistantId, { content: 'Error: ' + err.message, streaming: false });
    } finally {
      store.setState({ sendDisabled: false });
      scrollQuestionIntoTop(userId);
    }
  }

  function sendMessage() {
    const input = inputRef.current;
    const text = input.value.trim();
    const shots = store.getState().pendingScreenshots;

    if (shots.length > 0) {
      const images = [...shots];
      store.setState({ pendingScreenshots: [] });
      input.value = ''; input.style.height = 'auto';
      askWithScreenshots(images, text);
      return;
    }

    if (!text) return;
    store.setState({ sendDisabled: true });
    input.value = ''; input.style.height = 'auto';
    ask(text).finally(() => store.setState({ sendDisabled: false }));
  }

  function clearConversation() {
    store.setState({ conversation: [], navIndex: -1 });
  }

  // Only the background panel fades with this — text/icons/borders are
  // fixed, fully-legible colors in overlay.html's CSS and never dim, unlike
  // the old native BrowserWindow.setOpacity() which faded everything at once.
  function setOpacity(val) {
    store.setState({ opacity: val });
    document.documentElement.style.setProperty('--bg-alpha', ((Number(val) / 100) * 0.93).toFixed(3));
  }

  async function captureScreenshot() {
    store.setState({ capturingScreenshot: true });
    const result = await ipcRenderer.invoke('capture-screenshot');
    store.setState({ capturingScreenshot: false });

    if (result.error) { warningRef.current.showOnScreen('Screenshot failed: ' + result.error); return; }

    store.setState(s => ({ pendingScreenshots: [...s.pendingScreenshots, result.base64] }));
    const n = store.getState().pendingScreenshots.length;
    warningRef.current.showOnScreen(`📸 ${n} screenshot${n > 1 ? 's' : ''} attached — type a question or just hit Send`);

    // The screenshot button just took focus away from the textarea —
    // return it so typing and the Ctrl+Enter send shortcut work right away.
    if (inputRef.current) inputRef.current.focus();
  }

  function minimizeWindow() {
    const collapsed = !store.getState().collapsed;
    store.setState({ collapsed });
    ipcRenderer.send('resize-overlay', {
      width: FULL_WIDTH,
      height: collapsed ? COLLAPSED_HEIGHT : FULL_HEIGHT
    });
  }

  function toggleSettings() {
    store.setState(s => ({ settingsOpen: !s.settingsOpen }));
  }

  function closeSettings() {
    store.setState({ settingsOpen: false });
  }

  useEffect(() => {
    // Apply the store's initial opacity to the background CSS var — nothing
    // did this before the slider was first touched.
    setOpacity(store.getState().opacity);

    const cleanupScroll = questionNavRef.current.attachScrollListener();

    const onDocMouseDown = e => {
      if (!store.getState().settingsOpen) return;
      const panel = document.getElementById('settings-panel');
      const gearBtn = document.getElementById('settings-gear-btn');
      if ((panel && panel.contains(e.target)) || (gearBtn && gearBtn.contains(e.target))) return;
      store.setState({ settingsOpen: false });
    };
    document.addEventListener('mousedown', onDocMouseDown);

    const listeners = {
      'focus-input':            () => inputRef.current && inputRef.current.focus(),
      'clear-conversation':     () => clearConversation(),
      'toggle-listen':          () => voiceControllerRef.current.toggleListen(),
      'trigger-screen-analyze': () => captureScreenshot(),
      'toggle-collapse':        () => minimizeWindow(),
      'nav-prev-question':      () => questionNavRef.current.navigateQuestion(-1),
      'nav-next-question':      () => questionNavRef.current.navigateQuestion(+1),
      'jump-to-first-question': () => questionNavRef.current.jumpToQuestion(0),
      'jump-to-last-question':  () => questionNavRef.current.jumpToQuestion(Infinity),
      'account-received':       (_, account) => { store.setState({ account }); connectInterviewSocket().catch(() => {}); },
      'resume-parsed':          (_, text) => store.setState({ resumeText: text }),
      'interview-settings-received': (_, settings) => store.setState({ interviewSettings: settings }),
      'logged-out':             () => { store.setState({ account: null, resumeText: '', interviewSettings: null }); disconnectInterviewSocket(); },
      'update-ready':           (_, { version }) => store.setState({ updateReady: true, updateVersion: version }),
    };
    Object.entries(listeners).forEach(([ch, fn]) => ipcRenderer.on(ch, fn));

    const onOpacityStep = (_, step) => {
      const next = Math.min(100, Math.max(20, store.getState().opacity + step));
      setOpacity(next);
    };
    ipcRenderer.on('opacity-step', onOpacityStep);

    return () => {
      cleanupScroll();
      Object.entries(listeners).forEach(([ch, fn]) => ipcRenderer.removeListener(ch, fn));
      ipcRenderer.removeListener('opacity-step', onOpacityStep);
      document.removeEventListener('mousedown', onDocMouseDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return html`
    <div id="app">
      <${TitleBar}
        store=${store}
        onToggleListen=${() => voiceControllerRef.current.toggleListen()}
        onCaptureScreenshot=${captureScreenshot}
        onClear=${clearConversation}
        onMinimize=${minimizeWindow}
        onOpacityChange=${setOpacity}
        onToggleSettings=${toggleSettings}
        onQuit=${() => ipcRenderer.send('quit-app')}
      />
      <${SettingsPanel} store=${store} onClose=${closeSettings} />
      <${StatusWarning} store=${store} />
      <${UpdateBanner} store=${store} onRestart=${() => ipcRenderer.send('restart-and-install')} />
      <${VoiceBar} store=${store} voiceController=${voiceControllerRef.current} />
      <${Conversation} store=${store} containerRef=${conversationRef} />
      <${InputArea} store=${store} inputRef=${inputRef} onSend=${sendMessage} />
    </div>
  `;
}

module.exports = { App };
