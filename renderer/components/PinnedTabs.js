const { html } = require('../html');
const { useStoreSlice } = require('../hooks');
const { forgetPinnedScroll } = require('./PinnedQuestion');

// Row of tabs, one per pinned question, rendered directly under VoiceBar
// (the "speaking line") — see App.js. Replaces the old single-pin toggle:
// any number of questions can be pinned at once (VoiceBar's 📌 button adds
// one), and each tab here independently opens/closes its own panel in
// PinnedQuestion.js below. Clicking a tab's label toggles that panel;
// clicking its ✕ unpins it entirely (closing the panel too).
function PinnedTabs({ store }) {
  // One useStoreSlice call, not several — everything read straight off the
  // live snapshot (`s`) it's given, same reasoning as PinnedQuestion.js's
  // own selector: a second call referencing another call's *returned*
  // value would close over a stale copy of it until some unrelated store
  // update happened to fire next (useStoreSlice's subscription effect only
  // re-arms on `store` changing, never on a selector's own closure). Custom
  // isEqual since this returns a fresh array/objects every call.
  const tabs = useStoreSlice(store, s => s.pinnedIds
    .map((id, i) => {
      const msg = s.conversation.find(m => m.id === id);
      if (!msg) return null;
      return { id, label: shortLabel(msg.content, i), open: s.openPinnedIds.includes(id) };
    })
    .filter(Boolean),
  (a, b) => a.length === b.length
    && a.every((t, i) => t.id === b[i].id && t.label === b[i].label && t.open === b[i].open));

  if (!tabs.length) return null;

  function toggleOpen(id) {
    const open = store.getState().openPinnedIds;
    store.setState({
      openPinnedIds: open.includes(id) ? open.filter(x => x !== id) : [...open, id],
    });
  }

  function unpin(id, e) {
    e.stopPropagation();
    const { pinnedIds: ids, openPinnedIds: open } = store.getState();
    store.setState({
      pinnedIds: ids.filter(x => x !== id),
      openPinnedIds: open.filter(x => x !== id),
    });
    forgetPinnedScroll(id);
  }

  return html`
    <div id="pinned-tabs">
      ${tabs.map(tab => html`
        <button
          key=${tab.id}
          type="button"
          class="pinned-tab ${tab.open ? 'open' : ''}"
          title=${tab.open ? 'Click to collapse' : 'Click to expand'}
          onClick=${() => toggleOpen(tab.id)}
        >
          <span class="pinned-tab-label">📌 ${tab.label}</span>
          <span class="pinned-tab-close" title="Unpin" onClick=${e => unpin(tab.id, e)}>✕</span>
        </button>
      `)}
    </div>
  `;
}

// First few words of the question, so tabs stay identifiable at a glance
// instead of all reading "Pinned #1", "Pinned #2"...
function shortLabel(text, index) {
  const trimmed = (text || '').trim();
  if (!trimmed) return `Q${index + 1}`;
  const words = trimmed.split(/\s+/).slice(0, 4).join(' ');
  return words.length < trimmed.length ? `${words}…` : words;
}

module.exports = { PinnedTabs };
