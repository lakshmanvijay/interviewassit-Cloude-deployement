const { html } = require('../html');
const { useStoreSlice, useAssistCountdown } = require('../hooks');
const { OpacityPopup } = require('./OpacityPopup');

function TitleBar({ store, onToggleListen, onCaptureScreenshot, onClear, onMinimize, onOpacityChange, onToggleSettings, onToggleShortcuts, onToggleOpacity, onQuitSession, onQuit }) {
  const listening     = useStoreSlice(store, s => s.listening);
  const capturing     = useStoreSlice(store, s => s.capturingScreenshot);
  const collapsed     = useStoreSlice(store, s => s.collapsed);
  const opacityOpen   = useStoreSlice(store, s => s.opacityOpen);
  const settingsOpen  = useStoreSlice(store, s => s.settingsOpen);
  const shortcutsOpen = useStoreSlice(store, s => s.shortcutsOpen);
  const sessionStarted = useStoreSlice(store, s => s.sessionStarted);
  const account       = useStoreSlice(store, s => s.account);
  // Only the AI-answers page (conversation has at least one message) shows
  // the timer — sessionStarted alone isn't enough, since it's also true on
  // the "Ready." screen before anything's been asked yet (see
  // Conversation.js: EmptyState renders whenever conversation is empty,
  // regardless of sessionStarted).
  const hasAnswers = useStoreSlice(store, s => s.conversation.length > 0);
  // Turns red (see .assist-timer.critical) in the last 5 minutes so running
  // out isn't a surprise mid-answer. A free trial never sets
  // assistExpiresAt (see App.js's startTrial()), so its own trialExpiresAt
  // is checked too — at most one of the two is ever active.
  const assist = useAssistCountdown(store);
  const trial  = useAssistCountdown(store, 'trialExpiresAt');
  const timer  = hasAnswers && (assist || trial);

  return html`
    <div id="titlebar">
      <div class="title-left">
        <div class="logo-dot"></div>
        <span class="app-name">VijayamAI</span>
        <span class="stealth-badge">🔒 HIDDEN</span>
      </div>
      <div class="title-actions">
        ${sessionStarted && html`
          <button
            class="icon-btn ${listening ? 'listening' : ''}"
            id="mic-btn"
            onClick=${onToggleListen}
            title="🎤 Listen  [Ctrl+Shift+L]"
          >🎤</button>
          <button
            class="icon-btn"
            id="analyze-btn"
            disabled=${capturing}
            onClick=${onCaptureScreenshot}
            title="📸 Screenshot  [Ctrl+Shift+S]"
          >${capturing ? '⏳' : '📸'}</button>
          <button class="icon-btn" onClick=${onClear} title="⟳ Clear  [Ctrl+Shift+C]">⟳</button>
          ${timer && html`
            <span class="assist-timer ${timer.critical ? 'critical' : ''}" title=${trial ? 'Time left in this free trial' : 'Time left in this Live Assist session'}>
              ${trial ? '🎁 ' : ''}${timer.underOneMinute ? `${timer.totalSeconds}s` : `${timer.totalMinutes}m`}
            </span>
          `}
        `}
        <button
          class="icon-btn ${shortcutsOpen ? 'active' : ''}"
          onClick=${onToggleShortcuts}
          title="Keyboard shortcuts"
        >⌨</button>
        <button
          class="icon-btn avatar-btn ${settingsOpen ? 'active' : ''}"
          id="settings-gear-btn"
          onClick=${onToggleSettings}
          title=${account ? account.name : 'Account'}
        >${account ? account.name.charAt(0).toUpperCase() : '?'}</button>
        <div class="opacity-anchor">
          <button
            class="icon-btn ${opacityOpen ? 'active' : ''}"
            id="opacity-btn"
            onClick=${onToggleOpacity}
            title="Opacity  [Ctrl+Shift+[  /  ]]"
          >👁</button>
          <${OpacityPopup} store=${store} onOpacityChange=${onOpacityChange} />
        </div>
        <button
          class="icon-btn" id="minimize-btn"
          onClick=${onMinimize}
          title=${collapsed ? 'Expand' : 'Collapse  [Ctrl+Shift+M]'}
        >${collapsed ? '▲' : '−'}</button>
        ${sessionStarted && html`
          <button
            class="icon-btn"
            onClick=${onQuitSession}
            title="Quit session — end and return to the welcome screen"
          >⏻</button>
        `}
        <button
          class="icon-btn" id="close-btn"
          onClick=${onQuit}
          title="Close app"
        >✕</button>
      </div>
    </div>
  `;
}

module.exports = { TitleBar };
