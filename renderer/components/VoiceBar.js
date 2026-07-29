const { html } = require('../html');
const { useEffect, useRef } = require('preact/hooks');
const { useStoreSlice } = require('../hooks');

function VoiceBar({ store, voiceController }) {
  const voiceStatus    = useStoreSlice(store, s => s.voiceStatus);
  const liveTranscript = useStoreSlice(store, s => s.liveTranscript);
  const autoAsk        = useStoreSlice(store, s => s.autoAsk);
  const collapsed      = useStoreSlice(store, s => s.collapsed);
  const meterRef = useRef(null);

  // VAD energy is written straight to this node's style by the voice
  // controller (20fps), bypassing the store — animating it through state
  // would re-render this component dozens of times a second for nothing.
  useEffect(() => {
    voiceController.attachMeterEl(meterRef.current);
  }, [voiceController]);

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
    </div>
  `;
}

module.exports = { VoiceBar };
