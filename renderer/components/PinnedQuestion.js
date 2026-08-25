const { html } = require('../html');
const { useStoreSlice } = require('../hooks');
const { renderMarkdown } = require('../lib/markdown');

// Sticky panel rendered ABOVE the scrolling #conversation list (see App.js —
// it's a plain flex sibling, not position:sticky, so #conversation just
// shrinks to fill what's left rather than this overlapping content). Lets
// the user keep a coding question (and its answer) visible while writing
// code, even as the interviewer's next question(s) push it down out of view
// in the normal message list below. Toggled from VoiceBar's 📌 button, which
// pins whatever the most recent question was at the moment it's clicked.
function PinnedQuestion({ store }) {
  // One useStoreSlice call, not two — the selector reads pinnedMessageId
  // straight off the live state snapshot (`s`) it's given rather than off a
  // separate hook's return value closed over from a previous render.
  // useStoreSlice's subscription is only re-armed when `store` itself
  // changes (see hooks.js — its effect depends on [store], which never
  // changes here), not when a selector's own closure does, so a second call
  // whose selector referenced another call's *returned* pinnedId would keep
  // evaluating against a stale closure until some unrelated store update
  // happened to fire next — i.e. clicking "pin" wouldn't reliably show this
  // panel right away. Reading everything off `s` directly sidesteps that
  // entirely. Re-derives on every conversation change (not just when
  // pinnedMessageId itself changes) so a still-streaming answer to the
  // pinned question keeps updating live here too — custom isEqual since the
  // selector returns a fresh object each call, otherwise defeating
  // useStoreSlice's default Object.is check.
  const pinned = useStoreSlice(store, s => {
    const pinnedId = s.pinnedMessageId;
    if (!pinnedId) return null;
    const idx = s.conversation.findIndex(m => m.id === pinnedId);
    if (idx === -1) return null; // pinned message no longer exists (e.g. conversation cleared)
    const question = s.conversation[idx];
    const answer = s.conversation.slice(idx + 1).find(m => m.role === 'assistant') || null;
    return { question, answer };
  }, (a, b) => {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.question.content === b.question.content
      && (a.answer ? a.answer.content : null) === (b.answer ? b.answer.content : null)
      && (a.answer ? !!a.answer.streaming : false) === (b.answer ? !!b.answer.streaming : false);
  });

  if (!pinned) return null;
  const { question, answer } = pinned;
  const showMarkdown = answer && !answer.streaming;

  return html`
    <div id="pinned-question">
      <div class="pinned-header">
        <span>📌 Pinned</span>
        <button class="pinned-unpin" title="Unpin" onClick=${() => store.setState({ pinnedMessageId: null })}>✕</button>
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
}

module.exports = { PinnedQuestion };
