const { ipcRenderer } = require('electron');
const { html } = require('./html');
const { useRef, useEffect } = require('preact/hooks');

const { trialUsedAtKey } = require('./store');
const { getSystemPrompt } = require('./lib/prompts');
const { connect: connectInterviewSocket, disconnect: disconnectInterviewSocket, askBackend, cancelQuestion, CANCELLED_ERROR } = require('./lib/interviewSocket');
const { screenAnalyze } = require('./lib/screenAnalyze');
const { createVoiceController } = require('./lib/voice');
const { createWarningController } = require('./lib/warning');
const { createQuestionNav } = require('./lib/navigation');
const { scrollElIntoTop } = require('./lib/scroll');

const { TitleBar } = require('./components/TitleBar');
const { SettingsPanel } = require('./components/SettingsPanel');
const { ShortcutsModal } = require('./components/ShortcutsModal');
const { PaymentHistoryModal } = require('./components/PaymentHistoryModal');
const { FeedbackModal } = require('./components/FeedbackModal');
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
    // Capped per turn — priorHistory was folded in at full length, so one
    // long previous answer (multi-paragraph, with a code block) could add
    // several hundred extra tokens to EVERY question's prompt from then on,
    // for context that's rarely needed in full — the LLM only needs enough
    // of the prior turn to keep continuity, not a verbatim replay. Bigger
    // prompt = more for the provider to prefill before it can start
    // generating, which shows up directly as slower time-to-first-token.
    const HISTORY_TURN_MAX_CHARS = 400;
    const historyText = priorHistory.length
      ? '\n\nRECENT CONVERSATION:\n' + priorHistory.map(m => {
          const content = m.content.length > HISTORY_TURN_MAX_CHARS
            ? m.content.slice(0, HISTORY_TURN_MAX_CHARS) + '…'
            : m.content;
          return `${m.role === 'user' ? 'Q' : 'A'}: ${content}`;
        }).join('\n')
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
    // Latency instrumentation — brackets the leg voice.js's own STT-finalize
    // timing log can't see: from the moment we actually send the question
    // over the wire to the first answer token rendered. Combined with the
    // backend's own "First token in Xms" log (server-side, LLM+access-check
    // only), this pins down whether a slow-feeling answer is network time,
    // backend queueing, or the LLM itself.
    const askSentAt = performance.now();
    let firstTokenLogged = false;
    try {
      // Explicitly pinned to cerebras — it's the fast provider (500-2000+
      // tok/s on dedicated hardware vs ~20-80 tok/s for OpenAI/Anthropic).
      // Relying on the backend's default risks silently falling back to a
      // much slower provider (this has happened before — see the "No LLM
      // provider configured" incident). Remove this pin once the backend
      // default is confirmed fixed, if you'd rather not hardcode it here.
      const { id: askId, promise } = await askBackend(question, partial => {
        if (!firstTokenLogged) {
          firstTokenLogged = true;
          console.log(`[ask] first token in ${Math.round(performance.now() - askSentAt)}ms`);
        }
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
      // `text` (this ask() call's own param, the real short question — NOT
      // `question` above, which is the padded system-prompt+history+text
      // blob actually sent to the LLM) is passed as displayQuestion so the
      // backend persists the real question to Interview History instead of
      // that whole padded blob. See askBackend's displayQuestion param in
      // interviewSocket.js.
      }, 'cerebras', undefined, text);
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

  // Pending auto-quit for an in-progress free trial (see startTrial below).
  // Cleared in quitSession() too, so manually quitting early (the ⏻
  // titlebar button) can't leave a stray timer that fires later and
  // force-quits whatever session/trial is running by then.
  const trialTimerRef = useRef(null);

  // Ends the current interview: stops listening, wipes the conversation, and
  // drops sessionStarted back to false — since EmptyState only renders once
  // conversation is also empty (see Conversation.js), this is what actually
  // brings the welcome screen back rather than just hiding the input box.
  // Local UI reset happens immediately/synchronously for a snappy quit; the
  // actual POST /api/sessions/pause call (so idle time afterward isn't
  // billed) and balance refresh happen after, fire-and-forget from the
  // caller's perspective. Safe to call even when nothing real was open (a
  // purely local trial, or already-paused) — the backend just returns 204.
  // assistExpiresAt IS cleared now (unlike before Pause existed) — Pause
  // actually closes that window server-side, so leaving the countdown card
  // showing "active" after this would be showing a window that's no longer
  // open. The user's remaining minutes aren't lost (creditBalance still
  // reflects them); Activate just opens a fresh window against them next time.
  async function quitSession() {
    clearTimeout(trialTimerRef.current);
    voiceControllerRef.current.stopListening();
    clearConversation();
    // Captured before the setState below clears trialExpiresAt — this is
    // the only way to tell, at this point, whether what's ending was a free
    // trial (as opposed to a paid session, or nothing at all).
    const wasTrialActive = !!store.getState().trialExpiresAt;
    // feedbackOpen: true — prompts for a star rating right as the session
    // ends (see FeedbackModal.js), while the interview is still fresh in
    // mind, rather than leaving it to be volunteered unprompted.
    store.setState({ sessionStarted: false, sessionStartError: null, assistExpiresAt: null, trialExpiresAt: null, feedbackOpen: true });

    if (wasTrialActive) {
      // The post-trial cooldown counts from completion, not from when the
      // trial started — whether it ran the full 10 minutes (auto-timeout)
      // or was quit early. Re-anchor both the local display (trialUsedAt)
      // and the server's authoritative copy (POST /api/sessions/trial/end)
      // to right now. See InterviewSessionService.endTrial on the backend.
      const endedAt = Date.now();
      // Keyed per account (see store.js's trialUsedAtKey) — not a single
      // shared key — so this cooldown display only ever follows the
      // currently signed-in user, not whoever last ran a trial on this
      // installed app.
      const key = trialUsedAtKey(store.getState().account);
      if (key) { try { localStorage.setItem(key, String(endedAt)); } catch (e) {} }
      store.setState({ trialUsedAt: endedAt });
      ipcRenderer.invoke('end-trial-session').catch(() => {});
    }

    // Still called even after a trial — recordQuestion() (backend) attaches
    // any questions asked during the trial to a real InterviewSession row
    // (for history), and this closes that row out properly. No credit lot
    // is linked to it, so nothing gets billed either way.
    const result = await ipcRenderer.invoke('pause-live-assist-session');
    if (result.ok) {
      const balanceResult = await ipcRenderer.invoke('get-credit-balance');
      if (balanceResult.ok) store.setState({ creditBalance: balanceResult.balance });
    }
  }

  // 10-minute free trial. No POST /api/sessions/start and no credit lot is
  // ever touched — but the backend still needs to know a trial is running,
  // because InterviewWebSocketHandler gates every asked question against
  // real credits server-side (checkLiveAssistAccess), regardless of what
  // this client thinks its own state is. So this calls POST
  // /api/sessions/trial/start first: the backend stamps a trialStartedAt on
  // the user and, for the next 10 minutes, waves questions through free —
  // see InterviewSessionService.startTrial/isInTrialWindow. A 1-minute
  // cooldown counted from actual completion (see quitSession() above, which
  // re-anchors this once the trial ends) is enforced there too (429 if too
  // soon), authoritatively — trialUsedAt/localStorage here are just for the
  // client's own countdown display and are NOT what gates anything;
  // clearing localStorage can't get around the server-side cooldown.
  async function startTrial() {
    store.setState({ sessionStartError: null });
    let result;
    try {
      result = await ipcRenderer.invoke('start-trial-session');
    } catch (err) {
      // ipcRenderer.invoke() itself shouldn't reject (the main-process
      // handler always resolves), but if it somehow does, catch it here
      // rather than letting it become an unhandled rejection — see
      // index.js's crash-resilience guards for why that matters.
      warningRef.current.showOnScreen(`Couldn't start trial: ${err.message}`);
      return;
    }
    if (!result.ok) {
      const msg = (result.body && result.body.message) || `Couldn't start trial (status ${result.status})`;
      warningRef.current.showOnScreen(msg);
      return;
    }

    const usedAt = Date.now();
    // Keyed per account (see store.js's trialUsedAtKey) — see the matching
    // write in quitSession() for why this can't be one shared key.
    const usedAtKey = trialUsedAtKey(store.getState().account);
    if (usedAtKey) { try { localStorage.setItem(usedAtKey, String(usedAt)); } catch (e) {} }
    // trialExpiresAt drives TitleBar's in-session countdown badge (see
    // hooks.js's useAssistCountdown(store, 'trialExpiresAt')) — without it
    // the badge only ever reads assistExpiresAt (the paid-session field),
    // which a trial never sets, so it silently showed nothing during one.
    const trialExpiresAt = result.body && result.body.trialExpiresAt;
    store.setState({ trialUsedAt: usedAt, trialExpiresAt, sessionStarted: true, sessionStartError: null });
    voiceControllerRef.current.toggleListen();

    // Scheduled off the server's actual trialExpiresAt when present, rather
    // than always assuming a full fresh 10 minutes from right now — keeps
    // this in sync with the backend's own clock instead of drifting from it.
    const msLeft = trialExpiresAt ? new Date(trialExpiresAt).getTime() - Date.now() : 10 * 60 * 1000;

    clearTimeout(trialTimerRef.current);
    trialTimerRef.current = setTimeout(() => {
      trialTimerRef.current = null;
      quitSession();
    }, Math.max(0, msLeft));
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

  function toggleShortcuts() {
    store.setState(s => ({ shortcutsOpen: !s.shortcutsOpen }));
  }

  function closeShortcuts() {
    store.setState({ shortcutsOpen: false });
  }

  function closePaymentHistory() {
    store.setState({ paymentHistoryOpen: false });
  }

  function closeFeedback() {
    store.setState({ feedbackOpen: false });
  }

  function toggleOpacity() {
    store.setState(s => ({ opacityOpen: !s.opacityOpen }));
  }

  useEffect(() => {
    // Apply the store's initial opacity to the background CSS var — nothing
    // did this before the slider was first touched.
    setOpacity(store.getState().opacity);

    const cleanupScroll = questionNavRef.current.attachScrollListener();

    const onDocMouseDown = e => {
      if (store.getState().settingsOpen) {
        const panel = document.getElementById('settings-panel');
        const gearBtn = document.getElementById('settings-gear-btn');
        if (!((panel && panel.contains(e.target)) || (gearBtn && gearBtn.contains(e.target)))) {
          store.setState({ settingsOpen: false });
        }
      }
      if (store.getState().opacityOpen) {
        const popup = document.getElementById('opacity-popup');
        const opacityBtn = document.getElementById('opacity-btn');
        if (!((popup && popup.contains(e.target)) || (opacityBtn && opacityBtn.contains(e.target)))) {
          store.setState({ opacityOpen: false });
        }
      }
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
      // Also re-hydrates trialUsedAt from THIS account's own scoped
      // localStorage key (see store.js's trialUsedAtKey) rather than
      // whatever the store already had — otherwise, on a shared machine,
      // signing into account B right after account A had used the free
      // trial would keep showing A's cooldown on B's screen (store.trialUsedAt
      // starts at 0 on launch — see store.js — but a second account signing
      // in without an app restart would still be carrying A's value forward
      // without this).
      'account-received':       (_, account) => {
        const key = trialUsedAtKey(account);
        let trialUsedAt = 0;
        if (key) { try { trialUsedAt = Number(localStorage.getItem(key)) || 0; } catch (e) {} }
        store.setState({ account, trialUsedAt });
        connectInterviewSocket().catch(() => {});
        // Pull-based fallback for the ACTIVE SESSION restore, on top of the
        // 'active-assist-session' push below — see main.js's
        // get-active-assist-session for why the push alone wasn't fully
        // reliable. Safe to fire every time 'account-received' does (not
        // just once at cold start): a plain re-fetch, idempotent, and by
        // definition sessionToken is already set on the main-process side
        // once this event exists at all.
        ipcRenderer.invoke('get-active-assist-session')
          .then(expiresAt => { if (expiresAt) store.setState({ assistExpiresAt: expiresAt }); })
          .catch(() => {});
        // Same pull, same reason, for creditBalance — EmptyState.js's ACTIVE
        // SESSION card falls back to creditBalance.lots (soonestActiveLot)
        // whenever no session row is open, so this needs to arrive just as
        // reliably as assistExpiresAt does, and for the same reason
        // (renderer-ready's re-send alone wasn't enough — see this handler's
        // other pull above). Purely a background store update — doesn't
        // touch startingSession/disabled state on any button, "Start
        // listening"/"Continue" stay clickable the whole time regardless of
        // whether this has resolved yet, same as EmptyState.js's
        // startListening() already does with the server's actual response
        // being the sole source of truth rather than a client-side gate.
        ipcRenderer.invoke('get-credit-balance')
          .then(r => { if (r && r.ok) store.setState({ creditBalance: r.balance }); })
          .catch(() => {});
      },
      'resume-parsed':          (_, text) => store.setState({ resumeText: text }),
      'interview-settings-received': (_, settings) => store.setState({ interviewSettings: settings }),
      // CreditBalanceResponse, fetched at login/session-restore and after
      // every Activate/Pause — see EmptyState.js/App.js's quitSession().
      'credit-balance-received': (_, balance) => store.setState({ creditBalance: balance }),
      // { name, size, contentType, url, uploadedAt } — name is the real
      // uploaded filename, see EmptyState.js's setup-screen Resume row.
      'resume-info-received':   (_, resume) => store.setState({ resumeInfo: resume }),
      // An already-active Live Assist session found at login/session-restore
      // (GET /api/sessions/me) — its countdown survives an app restart
      // instead of only being known right after clicking "Start listening"
      // in this same run. Deliberately does NOT set sessionStarted: true —
      // the app always opens to the welcome screen first; an active window
      // just makes that screen show "Continue [ACTIVE]" with the real time
      // left, rather than skipping straight past it into the input view.
      'active-assist-session':  (_, expiresAt) => store.setState({ assistExpiresAt: expiresAt }),
      // trialUsedAt reset to 0 here too (on top of being re-hydrated per
      // account on the next 'account-received') so the brief logged-out
      // window in between never shows a stale cooldown left over from
      // whichever account was just signed out.
      'logged-out':             () => { clearTimeout(trialTimerRef.current); store.setState({ account: null, resumeText: '', interviewSettings: null, sessionStarted: false, assistExpiresAt: null, trialExpiresAt: null, trialUsedAt: 0, sessionStartError: null, paymentHistoryOpen: false, feedbackOpen: false, creditBalance: null, resumeInfo: null }); disconnectInterviewSocket(); },
      'update-ready':           (_, { version }) => store.setState({ updateReady: true, updateVersion: version }),
    };
    Object.entries(listeners).forEach(([ch, fn]) => ipcRenderer.on(ch, fn));

    const onOpacityStep = (_, step) => {
      const next = Math.min(100, Math.max(20, store.getState().opacity + step));
      setOpacity(next);
    };
    ipcRenderer.on('opacity-step', onOpacityStep);

    // Tells main.js it's now safe to push account/session-restore state —
    // see main.js's 'renderer-ready' handler for why this can't just rely on
    // 'did-finish-load' alone (that can fire before the listeners just above
    // are actually registered, silently dropping e.g. active-assist-session
    // on some runs).
    ipcRenderer.send('renderer-ready');

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
        onToggleShortcuts=${toggleShortcuts}
        onToggleOpacity=${toggleOpacity}
        onQuitSession=${quitSession}
        onQuit=${() => ipcRenderer.send('quit-app')}
      />
      <${SettingsPanel} store=${store} onClose=${closeSettings} />
      <${ShortcutsModal} store=${store} onClose=${closeShortcuts} />
      <${PaymentHistoryModal} store=${store} onClose=${closePaymentHistory} />
      <${FeedbackModal} store=${store} onClose=${closeFeedback} />
      <${StatusWarning} store=${store} />
      <${UpdateBanner} store=${store} onRestart=${() => ipcRenderer.send('restart-and-install')} />
      <${VoiceBar} store=${store} voiceController=${voiceControllerRef.current} />
      <${Conversation} store=${store} containerRef=${conversationRef} onToggleListen=${() => voiceControllerRef.current.toggleListen()} onStartTrial=${startTrial} />
      <${InputArea} store=${store} inputRef=${inputRef} onSend=${sendMessage} />
    </div>
  `;
}

module.exports = { App };
