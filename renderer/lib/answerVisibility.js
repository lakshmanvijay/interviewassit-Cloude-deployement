// Check complete replies before publishing a turn. Streaming fragments such
// as "I can" are ambiguous and must not flash a refusal onto the screen.
function isNonAnswer(reply) {
  const text = String(reply || '').replace(/[*_`#]/g, '').replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  if (!text) return true;
  // Suppress generic clarification-only replies, not an answer that happens
  // to end with a clarification. Every sentence must be a non-answer.
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [];
  const clarification = /^(?:(?:sorry|i'm sorry|i am sorry)[,:\s]+)?(?:i(?:'m| am) not sure (?:what|which)|i (?:don't|do not|didn't|did not) (?:understand|catch) (?:the|your|that)|(?:could|can|would) you (?:please )?(?:clarify|rephrase|repeat|provide more (?:detail|context)|share (?:the|your) (?:full|complete) question)|please (?:clarify|rephrase|repeat|provide (?:more (?:detail|context)|(?:a |the )?(?:full|complete|clear) question))|(?:the|your) (?:question|request) (?:is|seems) (?:unclear|incomplete)|(?:what|which) (?:term|concept|topic|question) (?:do|would|are) you)\b/i;
  const uncertainty = /^(?:(?:sorry|i'm sorry|i am sorry|unfortunately)[,:\s]+)?(?:i(?:'m| am) (?:not sure\b|not aware\b|unaware\b|not familiar\b|uncertain\b)|i (?:don't|do not) (?:know|understand)\b|i (?:don't|do not) have (?:enough|sufficient|the required|any) (?:information|context|details|knowledge)\b|i (?:cannot|can't|am unable to|am not able to) (?:understand|identify|determine|answer|provide (?:an? |the )?(?:accurate |reliable |proper )?answer)\b|i'm (?:unable|not able) to (?:understand|identify|determine|answer)\b|there (?:isn't|is not) enough (?:information|context)\b|(?:the|your) (?:question|request|meaning) (?:is|seems) (?:unclear|incomplete|ambiguous)\b)/i;
  const retry = /^(?:(?:please )?(?:try again|rephrase (?:that|it)|provide more (?:context|details))|(?:sorry|i'm sorry|i am sorry|unfortunately))[.!?]*$/i;
  const serviceError = /^(?:error\s*:|something went wrong\b|(?:an? )?(?:unexpected|internal server|network|connection) error (?:occurred|has occurred)\b|(?:the )?(?:service|model|server) is (?:temporarily )?unavailable\b)/i;
  if (sentences.length && sentences.every(sentence => {
    const part = sentence.trim();
    return clarification.test(part) || uncertainty.test(part) || retry.test(part) || serviceError.test(part);
  })) return true;
  const refusal = /^(?:(?:sorry|i'm sorry|i am sorry|unfortunately)[,.!:\s]+)?(?:i (?:can only|only (?:answer|help|assist)|cannot|can't|am unable to|am not able to)|i'm (?:unable to|not able to)|this (?:question|request|topic) (?:is (?:outside|unrelated|not related|beyond)|does not relate)|please (?:ask|provide|share) (?:an? )?(?:interview|role.related|resume.related|relevant) question)/i;
  // Restrict suppression to scope/assistance refusals, preserving technical
  // answers like "I cannot override a final method in Java."
  return refusal.test(text) && /(?:interview|selected (?:job )?role|resume|résumé|profile|scope|(?:answer|assist|help|respond) (?:with |to )?(?:that|this|your) (?:question|request)|unrelated|not related)/i.test(text);
}

function finishAnswerTurn(store, userId, assistantId, reply) {
  const hidden = isNonAnswer(reply);
  store.setState(s => ({
    conversation: hidden
      ? s.conversation.filter(m => m.id !== userId && m.id !== assistantId)
      : s.conversation.map(m => m.id === userId
        ? { ...m, hidden: false }
        : m.id === assistantId ? { ...m, content: reply, streaming: false, hidden: false } : m),
    ...(hidden ? {
      pinnedIds: s.pinnedIds.filter(id => id !== userId),
      openPinnedIds: s.openPinnedIds.filter(id => id !== userId),
      navIndex: -1,
    } : {}),
  }));
  return !hidden;
}

module.exports = { isNonAnswer, finishAnswerTurn };
