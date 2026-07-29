const { html } = require('../html');
const { memo } = require('preact/compat');
const { useStoreSlice } = require('../hooks');
const { renderMarkdown } = require('../lib/markdown');

// Subscribes only to its own message by id, so a streaming answer's content
// updates re-render this one leaf — not the conversation list, not the rest
// of the app. Wrapped in memo() so the parent list re-rendering (e.g. a new
// message appended) doesn't re-invoke unrelated Message instances either.
function MessageImpl({ store, id }) {
  const message = useStoreSlice(store, s => s.conversation.find(m => m.id === id));
  if (!message) return null;

  const { role, content, streaming } = message;
  const isAssistant = role === 'assistant';
  const showMarkdown = isAssistant && !streaming;

  return html`
    <div class="message ${role}" data-msg-id=${id}>
      <div class="message-role">${role === 'user' ? '▸ You' : '◆ AI'}</div>
      ${showMarkdown
        ? html`<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }}></div>`
        : html`<div class="message-content ${isAssistant && streaming ? 'streaming' : ''}">${content}</div>`}
    </div>
  `;
}

const Message = memo(MessageImpl);
module.exports = { Message };
