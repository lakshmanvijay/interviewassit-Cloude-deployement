const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('fresh questions do not merge into unpunctuated previous speech', async () => {
  for (const text of ['Why?', 'What is inheritance', 'Explain interfaces', 'And how does it work',
    'Like, what is Java?', 'Well, actually, explain interfaces', 'Okay. What is SQL?',
    'Please walk me through dependency injection', 'Give an example', 'Define polymorphism']) {
    const h = harness();
    await h.controller.handleTranscript(text, 'old', 'Explain closures');
    assert.equal(h.calls[0][0], text);
    assert.equal(h.calls[0][1], null);
    assert.equal(h.calls[0][2], false);
  }
});

test('a sentence continuation still extends the existing question', async () => {
  const h = harness();
  await h.controller.handleTranscript('in JavaScript', 'old', 'Explain closures');
  assert.equal(h.calls[0], 'cancel');
  assert.equal(h.calls[1][0], 'Explain closures in JavaScript');
  assert.equal(h.calls[1][2], true);
});

function harness(conversation = [], onTranscript = () => {}) {
  const calls = [];
  const sessions = [];
  let state = { conversation, autoAsk: true };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/lib/voice.js'), 'utf8')
    .replace('return { toggleListen, stopListening, attachMeterEl, isListening: () => listening };',
      `return { handleTranscript, handleSpeechStart, onAudioProcess, doEndUtterance,
        voiced(ms) { voicedMs = ms; },
        start() { listening = true; isSpeaking = true; audioCtx = { sampleRate: 16000 }; },
        previous() { lastQuestionAt = Date.now(); } };`);
  const context = {
    require(name) {
      if (name === 'electron') return { ipcRenderer: {} };
      if (name === './scroll') return { scrollElIntoTop() {} };
      if (name === './sttSocket') return { connectSttSession(language, onPartial) {
        const chunks = [];
        chunks.partial = text => { if (onPartial) onPartial(text); };
        sessions.push(chunks);
        return { sendAudio: b => chunks.push(b), ready: () => Promise.resolve(),
          abort() { chunks.aborted = true; },
          finish() { chunks.finished = true; return Promise.resolve({ text: 'Why?' }); } };
      } };
      return require(name);
    },
    module: { exports: {} }, __dirname, console, performance, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, context);
  const controller = context.module.exports.createVoiceController({
    store: { getState: () => state, setState(update) {
      state = { ...state, ...(typeof update === 'function' ? update(state) : update) };
    } },
    onTranscript: (...args) => { calls.push(args); return onTranscript(...args); },
    onSpeechResumed: () => calls.push('cancel'), showOnScreen() {},
  });
  return { controller, calls, sessions, state: () => state };
}

test('noise continuation leaves the existing answer alone', async () => {
  const h = harness([{ id: 'q', role: 'user', content: 'Explain closures' }]);
  await h.controller.handleTranscript('meow meow!', 'q', 'Explain closures');
  assert.equal(h.calls.length, 0);
  assert.equal(h.state().conversation[0].content, 'Explain closures');
});

test('acknowledgments and unfinished speech are silently removed without answering', async () => {
  for (const text of ['Like,', 'Like', 'So, like,', 'Yeah, sure, so,', 'And, actually, basically', 'Oh, no. Maybe', 'Yes. It will learn. I mean, the', 'Yes.', 'Okay, sure.', 'I mean, the']) {
    const h = harness([{ id: 'noise', role: 'user', content: text }]);
    await h.controller.handleTranscript(text, 'noise', '');
    assert.equal(h.calls.length, 0, text);
    assert.equal(h.state().conversation.length, 0, text);
  }
});

test('filler continuation preserves the current question and answer', async () => {
  const h = harness([
    { id: 'q', role: 'user', content: 'Explain SAP MM Yes.' },
    { id: 'a', role: 'assistant', content: 'Current answer', streaming: true },
  ]);
  await h.controller.handleTranscript('Yes.', 'q', 'Explain SAP MM');
  assert.equal(h.calls.length, 0);
  assert.equal(h.state().conversation[0].content, 'Explain SAP MM');
  assert.equal(h.state().conversation[1].content, 'Current answer');
  assert.equal(h.state().conversation[1].streaming, true);
});

test('real interview prompts and short follow-ups still get submitted', async () => {
  for (const text of ['Like, what is Java?', 'Explain SQL LIKE', 'Explain purchase orders', 'What is SAP MM?', 'Why?', 'Yes, explain goods receipt', 'SAP MM',
    'Splitter and manage to use user when it is user.',
    'What is split up and what are the in and when it is used?']) {
    const h = harness();
    await h.controller.handleTranscript(text, 'q', '');
    assert.equal(h.calls[0][0], text);
  }
});

test('short real questions are accepted without waiting for answer generation', async () => {
  const h = harness([], () => new Promise(() => {}));
  await h.controller.handleTranscript('Why?', 'q', '');
  assert.equal(h.calls[0][0], 'Why?');
});

test('a completed question is separate even while its answer streams', async () => {
  const h = harness([
    { id: 'q', role: 'user', content: 'What is Java?' },
    { id: 'a', role: 'assistant', content: '', streaming: true },
  ]);
  h.controller.start();
  h.controller.previous();
  await h.controller.handleSpeechStart();
  assert.equal(h.state().conversation.filter(m => m.role === 'user').length, 1);
  h.controller.voiced(600);
  await h.controller.doEndUtterance();
  assert.equal(h.calls[0][0], 'Why?');
  assert.notEqual(h.calls[0][1], 'q');
  assert.equal(h.calls[0][2], false);
});

test('small sounds and interim guesses never render a loading question', async () => {
  const h = harness();
  h.controller.start();
  await h.controller.handleSpeechStart();
  assert.equal(h.state().conversation.length, 0);
  h.sessions[0].partial('Maybe');
  assert.equal(h.state().conversation.length, 0);
  h.controller.voiced(300);
  await h.controller.doEndUtterance();
  assert.equal(h.state().conversation.length, 0);
  assert.equal(h.calls.length, 0);
});

test('audio captured before session creation is flushed in order', async () => {
  const h = harness();
  h.controller.start();
  h.controller.onAudioProcess({ data: new Float32Array([0.25, 0.5]) });
  await h.controller.handleSpeechStart();
  h.controller.onAudioProcess({ data: new Float32Array([0.75]) });
  assert.equal(h.sessions[0].length, 2);
  assert.equal(new Int16Array(h.sessions[0][0]).length, 2);
  assert.equal(new Int16Array(h.sessions[0][1]).length, 1);
});

test('brief disturbance cannot finalize transcription or replace an existing answer', async () => {
  const h = harness([
    { id: 'q', role: 'user', content: 'Explain closures' },
    { id: 'a', role: 'assistant', content: 'Existing answer', streaming: true },
  ]);
  h.controller.start();
  h.controller.previous();
  await h.controller.handleSpeechStart();
  h.controller.voiced(300);
  await h.controller.doEndUtterance();
  assert.equal(h.sessions[0].aborted, true);
  assert.equal(h.sessions[0].finished, undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.state().conversation[0].content, 'Explain closures');
  assert.equal(h.state().conversation[1].content, 'Existing answer');
});

test('sustained speech still finalizes and submits a short question', async () => {
  const h = harness();
  h.controller.start();
  await h.controller.handleSpeechStart();
  h.controller.voiced(600);
  await h.controller.doEndUtterance();
  assert.equal(h.sessions[0].finished, true);
  assert.equal(h.calls[0][0], 'Why?');
});
