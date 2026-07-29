const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

function ScreenshotStrip({ store }) {
  const shots = useStoreSlice(store, s => s.pendingScreenshots);

  function remove(idx) {
    store.setState(s => ({ pendingScreenshots: s.pendingScreenshots.filter((_, i) => i !== idx) }));
  }

  return html`
    <div id="screenshot-strip">
      ${shots.map((b64, i) => html`
        <div class="sc-thumb" key=${i}>
          <img src="data:image/jpeg;base64,${b64}" alt="screen ${i + 1}" />
          <span class="sc-badge">#${i + 1}</span>
          <button class="sc-remove" onClick=${() => remove(i)} title="Remove">×</button>
        </div>
      `)}
    </div>
  `;
}

module.exports = { ScreenshotStrip };
