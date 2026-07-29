const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

// Dropdown panel (toggled from the ⚙ button in TitleBar) where the user
// pastes their own Cerebras + Groq API keys — used for AI answers
// (Cerebras) and voice-to-text / screenshot analysis (Groq).
function SettingsPanel({ store, onSaveCerebrasKey, onSaveGroqKey, onClose }) {
  const open          = useStoreSlice(store, s => s.settingsOpen);
  const collapsed      = useStoreSlice(store, s => s.collapsed);
  const cerebrasApiKey = useStoreSlice(store, s => s.cerebrasApiKey);
  const groqApiKey     = useStoreSlice(store, s => s.groqApiKey);

  if (!open || collapsed) return null;

  return html`
    <div id="settings-panel">
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
