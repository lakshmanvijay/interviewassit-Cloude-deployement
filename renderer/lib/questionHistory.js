// Submitted questions remain useful context while their answers are pending.
// Keep whole turns so a history limit never leaves an answer without its question.
function getQuestionHistory(conversation, currentId) {
  const index = conversation.findIndex(m => m.id === currentId);
  const previous = index < 0 ? conversation : conversation.slice(0, index);
  const turns = [];
  let turn = null;
  for (const message of previous) {
    if (message.role === 'user') {
      turn = null;
      if (typeof message.content !== 'string' || !message.content.trim()) continue;
      turn = [{ role: 'user', content: message.content }];
      turns.push(turn);
    } else if (message.role === 'assistant' && turn && !message.hidden && !message.streaming
      && typeof message.content === 'string' && message.content.trim()
      && !message.content.startsWith('Error:')) {
      turn.push({ role: 'assistant', content: message.content });
    }
  }
  return turns.slice(-3).flat();
}

module.exports = { getQuestionHistory };
