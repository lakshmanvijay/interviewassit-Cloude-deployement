const { ipcRenderer } = require('electron');
const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

// Dropdown panel (toggled from the account avatar button in TitleBar) —
// shows the signed-in user's details/logout, plus the answer language-level
// setting. No API key inputs — Cerebras/Deepgram keys live server-side on
// the backend now, reached over WebSocket.
function SettingsPanel({ store, onClose }) {
  const open          = useStoreSlice(store, s => s.settingsOpen);
  const collapsed      = useStoreSlice(store, s => s.collapsed);
  const account        = useStoreSlice(store, s => s.account);
  const creditBalance  = useStoreSlice(store, s => s.creditBalance);
  const proficiencyLevel = useStoreSlice(store, s => s.proficiencyLevel);

  if (!open || collapsed) return null;

  return html`
    <div id="settings-panel">
      <div class="account-header">
        ${account ? html`
          <div class="settings-avatar">${account.name.charAt(0).toUpperCase()}</div>
          <div class="account-name">${account.name}</div>
          <div class="account-email">${account.email}</div>
          <span class="account-plan">${creditBalance && creditBalance.subscription ? creditBalance.subscription.label : creditBalance ? `${creditBalance.totalMinutesAvailable} min` : (account.plan || 'Free')}</span>
          <button class="settings-ok-btn logout-btn" onClick=${() => ipcRenderer.send('logout')}>Logout</button>
        ` : html`
          <div class="account-name">Not signed in</div>
          <button class="settings-ok-btn" onClick=${() => ipcRenderer.send('start-login')}>Login</button>
        `}
      </div>
      <div class="settings-row">
        <label for="proficiency-select">Answer Language Level</label>
        <select
          id="proficiency-select"
          value=${proficiencyLevel}
          onChange=${e => store.setState({ proficiencyLevel: e.currentTarget.value })}
        >
          <option value="basic">Basic — simple words, short sentences</option>
          <option value="intermediate">Intermediate — clear, conversational</option>
          <option value="advanced">Advanced — precise, native-level</option>
        </select>
      </div>
      <button class="settings-ok-btn" onClick=${onClose}>OK</button>
    </div>
  `;
}

module.exports = { SettingsPanel };
