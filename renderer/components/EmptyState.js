const { ipcRenderer, shell } = require('electron');
const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

const SHORTCUTS = [
  ['Ctrl+Shift+L', '🎤 Toggle listening'],
  ['Ctrl+Shift+S', '📸 Screenshot'],
  ['Ctrl+Shift+C', '⟳ Clear conversation'],
  ['Ctrl+Shift+M', '− Collapse / expand'],
  ['Ctrl+Shift+H', 'Hide / Show window'],
  ['Ctrl+Shift+A', 'Focus chat input'],
  ['Ctrl+Shift+↑', '▲ Previous question'],
  ['Ctrl+Shift+↓', '▼ Next question'],
  ['Ctrl+Shift+1', '↖ First question'],
  ['Ctrl+Shift+0', '↘ Last question'],
  ['Ctrl+Shift+[  /  ]', '👁 Opacity −/+'],
  ['Ctrl+Alt+↑↓←→', 'Move window'],
  ['Ctrl+Enter', 'Send message'],
];

function EmptyState({ store }) {
  const account = useStoreSlice(store, s => s.account);

  return html`
    <div class="empty-state" id="empty-state">
      <div class="empty-icon">⚡</div>
      <div class="empty-text">Ready. Hit 🔊 to capture interviewer audio.</div>
      <div class="login-section">
        ${account ? html`
          <div class="login-title">${account.name}</div>
          <div class="login-sub">${account.email}</div>
          <span class="account-plan">${account.credits != null ? `${account.credits} credits` : (account.plan || 'Free')}</span>
          ${account.resume && html`
            <a class="account-resume" onClick=${() => shell.openExternal(account.resume)}>View resume ↗</a>
          `}
          <button class="login-btn logout-btn" onClick=${() => ipcRenderer.send('logout')}>Logout</button>
        ` : html`
          <div class="login-title">VijayamAI</div>
          <div class="login-sub">Sign in to continue</div>
          <button class="login-btn" onClick=${() => ipcRenderer.send('start-login')}>Login</button>
        `}
      </div>
      <div class="shortcuts">
        ${SHORTCUTS.map(([key, desc]) => html`
          <div class="shortcut-row">
            <span class="shortcut-key">${key}</span>
            <span class="shortcut-desc">${desc}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}

module.exports = { EmptyState };
