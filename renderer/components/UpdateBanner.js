const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

function UpdateBanner({ store, onRestart }) {
  const updateReady   = useStoreSlice(store, s => s.updateReady);
  const updateVersion = useStoreSlice(store, s => s.updateVersion);
  const collapsed      = useStoreSlice(store, s => s.collapsed);

  if (!updateReady) return null;

  return html`
    <div id="update-banner" style=${collapsed ? 'display:none' : ''}>
      <span>⟳ Update v${updateVersion} ready</span>
      <button onClick=${onRestart}>Restart</button>
    </div>
  `;
}

module.exports = { UpdateBanner };
