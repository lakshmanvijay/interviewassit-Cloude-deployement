const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getQuestionHistory } = require('../renderer/lib/questionHistory');

test('follow-ups retain a pending question but never its partial answer', () => {
  assert.deepEqual(getQuestionHistory([
    { id: 'q', role: 'user', content: 'What is a closure?', hidden: true },
    { role: 'assistant', content: 'A closure is', streaming: true, hidden: true },
  ]), [{ role: 'user', content: 'What is a closure?' }]);
});

test('regeneration excludes the current question and its old answer', () => {
  assert.deepEqual(getQuestionHistory([
    { id: 'previous', role: 'user', content: 'Explain JavaScript' },
    { role: 'assistant', content: 'A programming language' },
    { id: 'current', role: 'user', content: 'Explain closures' },
    { role: 'assistant', content: 'Old answer' },
    { id: 'later', role: 'user', content: 'Explain promises' },
  ], 'current'), [
    { role: 'user', content: 'Explain JavaScript' },
    { role: 'assistant', content: 'A programming language' },
  ]);
});

test('history retains three whole turns and excludes hidden or failed answers', () => {
  const messages = [
    { role: 'assistant', content: 'Orphan answer' },
    { role: 'user', content: 'Old question' },
    { role: 'assistant', content: 'Old answer' },
    { role: 'user', content: 'First' },
    { role: 'assistant', content: 'Error: failed' },
    { role: 'user', content: 'Second' },
    { role: 'assistant', content: 'Hidden answer', hidden: true },
    { role: 'user', content: 'Third' },
    { role: 'assistant', content: 'Complete answer' },
  ];
  assert.deepEqual(getQuestionHistory(messages).map(m => m.content),
    ['First', 'Second', 'Third', 'Complete answer']);
});
