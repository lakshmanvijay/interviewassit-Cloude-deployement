const { ipcRenderer, shell } = require('electron');
const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

// Dropdown panel (toggled from the account avatar button in TitleBar) —
// shows the signed-in user's details/resume/logout, plus the user's own
// Cerebras + Groq API keys, used for AI answers (Cerebras) and
// voice-to-text / screenshot analysis (Groq).
function SettingsPanel({ store, onSaveCerebrasKey, onSaveGroqKey, onClose }) {
  const open          = useStoreSlice(store, s => s.settingsOpen);
  const collapsed      = useStoreSlice(store, s => s.collapsed);
  const cerebrasApiKey = useStoreSlice(store, s => s.cerebrasApiKey);
  const groqApiKey     = useStoreSlice(store, s => s.groqApiKey);
  const account        = useStoreSlice(store, s => s.account);

  if (!open || collapsed) return null;

  return html`
    <div id="settings-panel">
      <div class="account-header">
        ${account ? html`
          <div class="settings-avatar">${account.name.charAt(0).toUpperCase()}</div>
          <div class="account-name">${account.name}</div>
          <div class="account-email">${account.email}</div>
          <span class="account-plan">${account.credits != null ? `${account.credits} credits` : (account.plan || 'Free')}</span>
          ${account.resume && html`
            <a class="account-resume" onClick=${() => shell.openExternal(account.resume)}>View resume ↗</a>
          `}
          <button class="settings-ok-btn logout-btn" onClick=${() => ipcRenderer.send('logout')}>Logout</button>
        ` : html`
          <div class="account-name">Not signed in</div>
          <button class="settings-ok-btn" onClick=${() => ipcRenderer.send('start-login')}>Login</button>
        `}
      </div>
      <div class="settings-row">
        <label for="cerebras-key-input">Cerebras API Key</label>
        <input
          id="cerebras-key-input" type="password" spellcheck="false" autocomplete="off"
          placeholder="csk-…"
          value=${cerebrasApiKey}
          onInput=${e => onSaveCerebrasKey(e.currentTarget.value.trim())}
        />
      </div>
      <div class="settings-row">
        <label for="groq-key-input">Groq API Key</label>
        <input
          id="groq-key-input" type="password" spellcheck="false" autocomplete="off"
          placeholder="gsk_…"
          value=${groqApiKey}
          onInput=${e => onSaveGroqKey(e.currentTarget.value.trim())}
        />
      </div>
      <div class="settings-hint">Used for AI answers (Cerebras) and voice-to-text / screenshot analysis (Groq). Stored locally on this device only.</div>
      <button class="settings-ok-btn" onClick=${onClose}>OK</button>
    </div>
  `;
}

module.exports = { SettingsPanel };
