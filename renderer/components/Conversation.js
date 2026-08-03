const { html } = require('../html');
const { useStoreSlice } = require('../hooks');
const { EmptyState } = require('./EmptyState');
const { Message } = require('./Message');

function shallowArrayEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Only re-renders when a message is *added or removed* (ids list changes);
// per-token streaming updates are handled entirely inside each Message.
function Conversation({ store, containerRef }) {
  const ids       = useStoreSlice(store, s => s.conversation.map(m => m.id), shallowArrayEqual);
  const collapsed = useStoreSlice(store, s => s.collapsed);

  return html`
    <div id="conversation" ref=${containerRef} style=${collapsed ? 'display:none' : ''}>
      ${ids.length === 0
        ? html`<${EmptyState} store=${store} />`
        : ids.map(id => html`<${Message} key=${id} store=${store} id=${id} />`)}
    </div>
  `;
}

module.exports = { Conversation };
