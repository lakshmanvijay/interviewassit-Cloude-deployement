const { html } = require('../html');

const SHORTCUTS = [
  ['Ctrl+Shift+L', '🔊 Toggle listening'],
  ['Ctrl+Shift+S', '📸 Screenshot'],
  ['Ctrl+Shift+X', '⎘ Copy last answer'],
  ['Ctrl+Shift+C', '⟳ Clear conversation'],
  ['Ctrl+Shift+M', '− Collapse / expand'],
  ['Ctrl+Shift+H', 'Hide / Show window'],
  ['Ctrl+Shift+A', 'Focus chat input'],
  ['Ctrl+Shift+,', '◀ Previous question'],
  ['Ctrl+Shift+.', '▶ Next question'],
  ['Ctrl+Shift+1', '↖ First question'],
  ['Ctrl+Shift+0', '↘ Last question'],
  ['Ctrl+Shift+[  /  ]', '👁 Opacity −/+'],
  ['Ctrl+Alt+↑↓←→', 'Move window'],
  ['Ctrl+Enter', 'Send message'],
];

function EmptyState() {
  return html`
    <div class="empty-state" id="empty-state">
      <div class="empty-icon">⚡</div>
      <div class="empty-text">Ready. Hit 🔊 to capture interviewer audio.</div>
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
