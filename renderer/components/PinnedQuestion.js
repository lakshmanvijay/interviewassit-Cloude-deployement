const { html } = require('../html');
const { useStoreSlice } = require('../hooks');
const { renderMarkdown } = require('../lib/markdown');

// Sticky panels rendered ABOVE the scrolling #conversation list (see App.js —
// it's a plain flex sibling, not position:sticky, so #conversation just
// shrinks to fill what's left rather than this overlapping content). Lets
// the user keep a coding question (and its answer) visible while writing
// code, even as the interviewer's next question(s) push it down out of view
// in the normal message list below. One panel per tab in PinnedTabs.js that
// the user has toggled open — any number of questions can be pinned and
// expanded at once, in the order they were pinned.
function PinnedQuestion({ store }) {
  // One useStoreSlice call, not several — everything read straight off the
  // live snapshot (`s`) it's given, so clicking a tab shows/hides its panel
  // right away instead of waiting on some unrelated store update (see
  // PinnedTabs.js's identical comment for why a second call referencing
  // another call's *returned* value would risk a stale closure here).
  // Re-derives on every conversation change (not just when pinned/open ids
  // change) so a still-streaming answer to a pinned question keeps updating
  // live here too — custom isEqual since the selector returns fresh objects
  // every call.
  const panels = useStoreSlice(store, s => s.openPinnedIds
    .map(id => {
      const idx = s.conversation.findIndex(m => m.id === id);
      if (idx === -1) return null; // pinned message no longer exists (e.g. conversation cleared)
      const question = s.conversation[idx];
      const answer = s.conversation.slice(idx + 1).find(m => m.role === 'assistant') || null;
      return { id, question, answer };
    })
    .filter(Boolean),
  (a, b) => a.length === b.length && a.every((p, i) =>
    p.id === b[i].id
    && p.question.content === b[i].question.content
    && (p.answer ? p.answer.content : null) === (b[i].answer ? b[i].answer.content : null)
    && (p.answer ? !!p.answer.streaming : false) === (b[i].answer ? !!b[i].answer.streaming : false)));

  if (!panels.length) return null;

  function closePanel(id) {
    store.setState({ openPinnedIds: store.getState().openPinnedIds.filter(x => x !== id) });
  }

  return html`
    ${panels.map(({ id, question, answer }) => {
      const showMarkdown = answer && !answer.streaming;
      return html`
        <div key=${id} class="pinned-question">
          <div class="pinned-header">
            <span>📌 Pinned</span>
            <button class="pinned-unpin" title="Collapse" onClick=${() => closePanel(id)}>✕</button>
          </div>
          <div class="pinned-question-text">${question.content}</div>
          ${answer && html`
            <!-- .message.assistant wrapper (not just .pinned-answer) so this picks up the
                 exact same code-block/prose styling the main conversation's Message.js uses. -->
            <div class="pinned-answer message assistant">
              ${showMarkdown
                ? html`<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(answer.content) }}></div>`
                : html`<div class="message-content ${answer.streaming ? 'streaming' : ''}">${answer.content}</div>`}
            </div>
          `}
        </div>
      `;
    })}
  `;
}

module.exports = { PinnedQuestion };
