const { html } = require('../html');
const { useEffect, useRef } = require('preact/hooks');
const { useStoreSlice } = require('../hooks');
const { pinCurrentQuestion } = require('../lib/pinnedQuestions');

function VoiceBar({ store, voiceController }) {
  const voiceStatus    = useStoreSlice(store, s => s.voiceStatus);
  const liveTranscript = useStoreSlice(store, s => s.liveTranscript);
  const autoAsk        = useStoreSlice(store, s => s.autoAsk);
  const pinnedIds       = useStoreSlice(store, s => s.pinnedIds);
  // Id of the most recent user message — read via a subscribed selector
  // (not store.getState() in the render body) so the pin button's "already
  // pinned" state actually updates when a new question comes in, not just
  // whenever some other prop happens to re-render this component.
  const currentQuestionId = useStoreSlice(store, s => {
    const lastUser = [...s.conversation].reverse().find(m => m.role === 'user');
    return lastUser ? lastUser.id : null;
  });
  const collapsed      = useStoreSlice(store, s => s.collapsed);
  // Same gate InputArea.js already uses — this bar was only ever hidden via
  // `collapsed`, so it stayed fully visible (showing whatever voiceStatus
  // was last set to, e.g. a stale "capturing internal audio") on the welcome
  // screen after quitting a session, since quitting drops sessionStarted
  // back to false but leaves conversation empty, which is exactly when
  // Conversation.js renders EmptyState instead of messages — this bar isn't
  // part of that screen at all conceptually, mic status only matters once a
  // session is actually running.
  const sessionStarted = useStoreSlice(store, s => s.sessionStarted);
  const meterRef = useRef(null);

  // VAD energy is written straight to this node's style by the voice
  // controller (20fps), bypassing the store — animating it through state
  // would re-render this component dozens of times a second for nothing.
  useEffect(() => {
    voiceController.attachMeterEl(meterRef.current);
  }, [voiceController]);

  if (!sessionStarted) return null;

  const currentIsPinned = !!currentQuestionId && pinnedIds.includes(currentQuestionId);

  return html`
    <div id="voice-bar" style=${collapsed ? 'display:none' : ''}>
      <span id="voice-status" class=${voiceStatus.cls}>
        ${(voiceStatus.cls === 'live' || voiceStatus.cls === 'speaking')
          ? html`<span class="live-dot"></span>${voiceStatus.text}`
          : voiceStatus.text}
      </span>
      <span id="live-transcript">${liveTranscript}</span>
      <div id="vad-meter"><div id="vad-fill" ref=${meterRef}></div></div>
      <label class="auto-toggle" title="Auto-send each detected sentence to the AI">
        <input
          type="checkbox" id="auto-ask"
          checked=${autoAsk}
          onChange=${e => store.setState({ autoAsk: e.currentTarget.checked })}
        /> auto
      </label>
      <button
        type="button"
        class="pin-toggle-btn ${currentIsPinned ? 'active' : ''}"
        title=${currentIsPinned ? 'Current question already pinned' : 'Pin current question as a tab'}
        onClick=${() => pinCurrentQuestion(store)}
      >📌</button>
    </div>
  `;
}

module.exports = { VoiceBar };
