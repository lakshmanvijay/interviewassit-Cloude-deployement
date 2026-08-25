const { html } = require('../html');
const { useEffect, useRef } = require('preact/hooks');
const { useStoreSlice } = require('../hooks');

function VoiceBar({ store, voiceController }) {
  const voiceStatus    = useStoreSlice(store, s => s.voiceStatus);
  const liveTranscript = useStoreSlice(store, s => s.liveTranscript);
  const autoAsk        = useStoreSlice(store, s => s.autoAsk);
  const pinnedMessageId = useStoreSlice(store, s => s.pinnedMessageId);
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

  // Pins whichever question is most recent right now (so it stays visible
  // at the top — see PinnedQuestion.js — while the interviewer keeps asking
  // more, which would otherwise push it down out of view mid-answer/mid-
  // code). Clicking again while something's already pinned just unpins it,
  // same as the ✕ on the pinned panel itself.
  function togglePin() {
    if (pinnedMessageId) {
      store.setState({ pinnedMessageId: null });
      return;
    }
    const conv = store.getState().conversation;
    const lastUser = [...conv].reverse().find(m => m.role === 'user');
    if (lastUser) store.setState({ pinnedMessageId: lastUser.id });
  }

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
        class="pin-toggle-btn ${pinnedMessageId ? 'active' : ''}"
        title=${pinnedMessageId ? 'Unpin question' : 'Pin current question to top'}
        onClick=${togglePin}
      >📌</button>
    </div>
  `;
}

module.exports = { VoiceBar };
