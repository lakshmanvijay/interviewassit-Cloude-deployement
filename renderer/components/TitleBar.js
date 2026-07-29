const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

function TitleBar({ store, onToggleListen, onCaptureScreenshot, onClear, onCopy, onMinimize, onOpacityChange, onToggleSettings }) {
  const listening     = useStoreSlice(store, s => s.listening);
  const capturing     = useStoreSlice(store, s => s.capturingScreenshot);
  const collapsed     = useStoreSlice(store, s => s.collapsed);
  const opacity       = useStoreSlice(store, s => s.opacity);
  const settingsOpen  = useStoreSlice(store, s => s.settingsOpen);

  return html`
    <div id="titlebar">
      <div class="title-left">
        <div class="logo-dot"></div>
        <span class="app-name">InterviewAssist</span>
        <span class="stealth-badge">🔒 HIDDEN</span>
      </div>
      <div class="title-actions">
        <button
          class="icon-btn ${listening ? 'listening' : ''}"
          id="mic-btn"
          onClick=${onToggleListen}
          title="🔊 Listen  [Ctrl+Shift+L]"
        >🔊</button>
        <button
          class="icon-btn"
          id="analyze-btn"
          disabled=${capturing}
          onClick=${onCaptureScreenshot}
          title="📸 Screenshot  [Ctrl+Shift+S]"
        >${capturing ? '⏳' : '📸'}</button>
        <button class="icon-btn" onClick=${onClear} title="⟳ Clear  [Ctrl+Shift+C]">⟳</button>
        <button class="icon-btn" onClick=${onCopy} title="⎘ Copy answer  [Ctrl+Shift+X]">⎘</button>
        <button
          class="icon-btn ${settingsOpen ? 'active' : ''}"
          id="settings-gear-btn"
          onClick=${onToggleSettings}
          title="⚙ API keys"
        >⚙</button>
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
      </div>
    </div>
  `;
}

module.exports = { TitleBar };
