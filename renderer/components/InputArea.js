const { html } = require('../html');
const { useStoreSlice } = require('../hooks');
const { ScreenshotStrip } = require('./ScreenshotStrip');

// The textarea is intentionally uncontrolled (no `value` binding) — typing
// is read straight off the DOM at send time, exactly like the original
// vanilla version, so keystrokes never round-trip through the store.
function InputArea({ store, inputRef, onSend }) {
  const sendDisabled   = useStoreSlice(store, s => s.sendDisabled);
  const collapsed      = useStoreSlice(store, s => s.collapsed);
  // Hidden until the user clicks "Continue" on the pre-session screen
  // (EmptyState, gated there on account.credits > 0) — see store.js.
  const sessionStarted = useStoreSlice(store, s => s.sessionStarted);

  function handleInput(e) {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); onSend(); }
  }

  if (!sessionStarted) return null;

  return html`
    <div id="input-area" style=${collapsed ? 'display:none' : ''}>
      <${ScreenshotStrip} store=${store} />
      <div class="input-row">
        <textarea
          id="prompt-input" ref=${inputRef} rows="2"
          placeholder="Type a question, or click 📸 to attach a screenshot, then Ctrl+Enter to send…"
          onInput=${handleInput}
          onKeyDown=${handleKeyDown}
        ></textarea>
        <button id="send-btn" disabled=${sendDisabled} onClick=${onSend}>Send ↵</button>
      </div>
    </div>
  `;
}

module.exports = { InputArea };
