const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

// Moved out of the always-visible EmptyState screen (see EmptyState.js) into
// its own on-demand popup, opened via the ⌨ titlebar button — keeps the
// pre-session screen focused on account/session status instead of a long
// static list.
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

function ShortcutsModal({ store, onClose }) {
  const open = useStoreSlice(store, s => s.shortcutsOpen);
  if (!open) return null;

  return html`
    <div id="shortcuts-backdrop" onClick=${onClose}>
      <div id="shortcuts-modal" onClick=${e => e.stopPropagation()}>
        <div class="shortcuts-modal-header">
          <span>⌨ Keyboard Shortcuts</span>
          <button class="icon-btn" onClick=${onClose} title="Close">✕</button>
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
    </div>
  `;
}

module.exports = { ShortcutsModal };
