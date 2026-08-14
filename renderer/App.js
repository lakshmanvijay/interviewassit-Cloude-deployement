const { ipcRenderer } = require('electron');
const { html } = require('./html');
const { useRef, useEffect } = require('preact/hooks');

const { getSystemPrompt } = require('./lib/prompts');
const { connect: connectInterviewSocket, disconnect: disconnectInterviewSocket, askBackend } = require('./lib/interviewSocket');
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

  async function ask(text) {
    text = (text || '').trim();
    if (!text) return;

    // Captured *before* the new user message is appended below, so it holds
    // prior turns only — the backend's WS API takes one flat `question`
    // string (no separate messages array), so recent history gets folded
    // into that string instead of duplicating the question we're about to ask.
    const priorHistory = store.getState().conversation.slice(-2).map(m => ({ role: m.role, content: m.content }));

    const userId = genId();
    store.setState(s => ({ conversation: [...s.conversation, { id: userId, role: 'user', content: text }] }));
    scrollQuestionIntoTop(userId);

    const { mode, resumeText, proficiencyLevel, interviewSettings } = store.getState();
    const systemPrompt = getSystemPrompt(mode, resumeText, proficiencyLevel, interviewSettings);
    const historyText = priorHistory.length
      ? '\n\nRECENT CONVERSATION:\n' + priorHistory.map(m => `${m.role === 'user' ? 'Q' : 'A'}: ${m.content}`).join('\n')
      : '';
    const question = `${systemPrompt}${historyText}\n\nNEW QUESTION:\n${text}`;

    const assistantId = genId();
    store.setState(s => ({ conversation: [...s.conversation, { id: assistantId, role: 'assistant', content: '', streaming: true }] }));

    let lastRenderAt = 0;
    try {
      // Explicitly pinned to cerebras — it's the fast provider (500-2000+
      // tok/s on dedicated hardware vs ~20-80 tok/s for OpenAI/Anthropic).
      // Relying on the backend's default risks silently falling back to a
      // much slower provider (this has happened before — see the "No LLM
      // provider configured" incident). Remove this pin once the backend
      // default is confirmed fixed, if you'd rather not hardcode it here.
      const reply = await askBackend(question, partial => {
        const now = performance.now();
        if (now - lastRenderAt < 30) return;
        lastRenderAt = now;
        updateMessage(assistantId, { content: partial });
      }, 'cerebras');
      updateMessage(assistantId, { content: reply, streaming: false });
      warningRef.current.showWarning('');
    } catch (err) {
      updateMessage(assistantId, { content: 'Error: ' + err.message, streaming: false });
      warningRef.current.showWarning(err.message);
    } finally {
      scrollQuestionIntoTop(userId);
    }
  }

  const voiceControllerRef = useRef(null);
  if (!voiceControllerRef.current) {
    voiceControllerRef.current = createVoiceController({
      store,
      showOnScreen: warningRef.current.showOnScreen,
      onTranscript: async text => {
        if (store.getState().autoAsk) {
          await ask(text);
          return;
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
