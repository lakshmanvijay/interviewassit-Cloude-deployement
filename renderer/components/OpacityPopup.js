const { html } = require('../html');
const { useStoreSlice } = require('../hooks');

// Small anchored popover opened from the 👁 titlebar button — the slider
// used to sit inline in the titlebar permanently, which made it too wide
// (crowding the mic/screenshot/clear/account buttons on an already-narrow
// bar). Now it's tucked behind one icon and only takes up space while
// actually being adjusted, same interaction as SettingsPanel/ShortcutsModal.
function OpacityPopup({ store, onOpacityChange }) {
  const open    = useStoreSlice(store, s => s.opacityOpen);
  const opacity = useStoreSlice(store, s => s.opacity);
  if (!open) return null;

  return html`
    <div id="opacity-popup">
      <div class="opacity-popup-header">
        <span>👁 Opacity</span>
        <span class="opacity-value">${opacity}%</span>
      </div>
      <input
        type="range" id="opacity-slider" min="20" max="100"
        value=${opacity}
        onInput=${e => onOpacityChange(Number(e.currentTarget.value))}
      />
    </div>
  `;
}

module.exports = { OpacityPopup };
