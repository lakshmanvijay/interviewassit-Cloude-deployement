const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

function TitleBar({ store, onToggleListen, onCaptureScreenshot, onClear, onMinimize, onOpacityChange, onToggleSettings, onToggleShortcuts, onQuitSession, onQuit }) {
  const listening     = useStoreSlice(store, s => s.listening);
  const capturing     = useStoreSlice(store, s => s.capturingScreenshot);
  const collapsed     = useStoreSlice(store, s => s.collapsed);
  const opacity       = useStoreSlice(store, s => s.opacity);
  const settingsOpen  = useStoreSlice(store, s => s.settingsOpen);
  const shortcutsOpen = useStoreSlice(store, s => s.shortcutsOpen);
  const sessionStarted = useStoreSlice(store, s => s.sessionStarted);
  const account       = useStoreSlice(store, s => s.account);

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
        <div class="opacity-wrap" title="Opacity  [Ctrl+Shift+[  /  ]]">
          <span>👁</span>
          <input
            type="range" id="opacity-slider" min="20" max="100"
            value=${opacity}
            onInput=${e => onOpacityChange(Number(e.currentTarget.value))}
          />
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
