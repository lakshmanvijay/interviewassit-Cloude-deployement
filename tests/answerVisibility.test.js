const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNonAnswer, finishAnswerTurn } = require('../renderer/lib/answerVisibility');

test('empty and scope-refusal answers are suppressed', () => {
  for (const reply of ['', '  ',
    'I can only answer interview questions related to your selected job role and resume.',
    '**Sorry,** I cannot answer questions outside your selected job role.',
    "I'm unable to help with this request because it is outside the interview scope.",
    'This question is unrelated to your resume.',
    'Please ask a relevant question related to your selected job role.',
  ]) assert.equal(isNonAnswer(reply), true, reply);
});

test('real technical answers and clarifications remain visible', () => {
  for (const reply of ['Java is a general-purpose, object-oriented programming language.',
    'I cannot override a final method in Java.',
    'I use Spring Boot to build REST APIs.',
    'Which Java version are you using?',
    'Java is a programming language. Could you clarify the question?',
  ]) assert.equal(isNonAnswer(reply), false, reply);
});

test('generic clarification-only responses are hidden', () => {
  for (const reply of [
    'I’m not sure which term or concept you’d like me to explain. Could you clarify the question?',
    'Could you please clarify your question?',
    'Please provide a complete question.',
    'Your question seems incomplete. Can you rephrase it?',
  ]) assert.equal(isNonAnswer(reply), true, reply);
});

test('uncertainty and error-only responses are skipped across wording variants', () => {
  for (const reply of [
    'I’m not sure I understand the question. Could you clarify which term or concept you’d like me to address?',
    "I'm not aware of that concept. Please provide more context.",
    'I am not familiar with this term.',
    'Sorry. I do not know the answer.',
    'I don’t have enough information to answer your question.',
    'I cannot provide an accurate answer without more context.',
    'Your question is ambiguous. Could you rephrase it?',
    'Something went wrong. Please try again.',
    'Error: The model is unavailable. Try again.',
  ]) assert.equal(isNonAnswer(reply), true, reply);
});

test('qualified substantive answers are not discarded', () => {
  for (const reply of [
    'I am not sure which version you use. In Java 17, sealed classes restrict which classes can extend them.',
    'I do not know your schema. An index can speed up reads but increases write overhead.',
    'I cannot determine the cause without logs. Check the connection pool for exhausted connections.',
    'Error handling in Java uses try, catch, and finally.',
  ]) assert.equal(isNonAnswer(reply), false, reply);
});

test('uncertainty removes the question and answer rather than publishing them', () => {
  let state = { conversation: [{ id: 'q', hidden: true }, { id: 'a', hidden: true }],
    pinnedIds: [], openPinnedIds: [], navIndex: -1 };
  const store = { setState: fn => { state = { ...state, ...fn(state) }; } };
  assert.equal(finishAnswerTurn(store, 'q', 'a', 'I’m not sure I understand the question. Could you clarify which term or concept you’d like me to address?'), false);
  assert.deepEqual(state.conversation, []);
});

test('refusals remove only their own turn and pins', () => {
  let state = { conversation: [{ id: 'old' }, { id: 'q', hidden: true }, { id: 'a', hidden: true }],
    pinnedIds: ['old', 'q'], openPinnedIds: ['q'], navIndex: 1 };
  const store = { setState: fn => { state = { ...state, ...fn(state) }; } };
  finishAnswerTurn(store, 'q', 'a', 'I can only answer interview questions related to your selected job role and resume.');
  assert.deepEqual(state.conversation, [{ id: 'old' }]);
  assert.deepEqual(state.pinnedIds, ['old']);
  assert.deepEqual(state.openPinnedIds, []);
});

test('a real completed answer reveals both messages atomically', () => {
  let state = { conversation: [{ id: 'q', hidden: true }, { id: 'a', hidden: true, streaming: true }] };
  const store = { setState: fn => { state = { ...state, ...fn(state) }; } };
  assert.equal(finishAnswerTurn(store, 'q', 'a', 'Java is a programming language.'), true);
  assert.equal(state.conversation[0].hidden, false);
  assert.equal(state.conversation[1].hidden, false);
  assert.equal(state.conversation[1].streaming, false);
  assert.equal(state.conversation[1].content, 'Java is a programming language.');
});
