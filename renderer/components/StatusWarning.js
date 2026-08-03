const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

function StatusWarning({ store }) {
  const warning   = useStoreSlice(store, s => s.warning);
  const collapsed = useStoreSlice(store, s => s.collapsed);

  return html`
    <div id="status-warning" class=${warning ? '' : 'hidden'} style=${collapsed ? 'display:none' : ''}>${warning ? '⚠ ' + warning : ''}</div>
  `;
}

module.exports = { StatusWarning };
