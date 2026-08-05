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
  // Separate slice, compared by value (a plain number) rather than object
  // reference — so this doesn't re-render on unrelated store changes the
  // way returning a new object every time would. Only user messages are
  // numbered; assistant replies don't get a question number.
  const questionNumber = useStoreSlice(store, s => {
    const msg = s.conversation.find(m => m.id === id);
    if (!msg || msg.role !== 'user') return null;
    return s.conversation.filter(m => m.role === 'user').indexOf(msg) + 1;
  });
  if (!message) return null;

  const { role, content, streaming } = message;
  const isAssistant = role === 'assistant';
  const showMarkdown = isAssistant && !streaming;

  return html`
    <div class="message ${role}" data-msg-id=${id}>
      <div class="message-role">${role === 'user' ? '▸ You' : '◆ AI'}</div>
      ${showMarkdown
        ? html`<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }}></div>`
        : role === 'user'
          ? html`<div class="message-content question-text"><span class="question-number">Q${questionNumber}:</span> ${content}</div>`
          : html`<div class="message-content ${isAssistant && streaming ? 'streaming' : ''}">${content}</div>`}
    </div>
  `;
}

const Message = memo(MessageImpl);
module.exports = { Message };
