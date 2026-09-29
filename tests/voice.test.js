const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('quick continuations merge even when they start with question words', async () => {
  for (const text of ['Why?', 'What is inheritance', 'Explain interfaces', 'And how does it work',
    'Like, what is Java?', 'Well, actually, explain interfaces', 'Okay. What is SQL?',
    'Please walk me through dependency injection', 'Give an example', 'Define polymorphism']) {
    const h = harness();
    await h.controller.handleTranscript(text, 'old', 'Explain closures');
    assert.equal(h.calls[0], 'cancel');
    assert.equal(h.calls[1][0], `Explain closures ${text}`);
    assert.equal(h.calls[1][1], 'old');
    assert.equal(h.calls[1][2], true);
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
        previous(age = 0) { lastQuestionAt = Date.now() - age; } };`);
  const context = {
    require(name) {
      if (name === 'electron') return { ipcRenderer: {} };
      if (name === './scroll') return { scrollElIntoTop() {} };
      if (name === './sttSocket') return { connectSttSession(language, onPartial) {
        assert.equal(language, 'en');
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

test('a longer gap starts a new question even while the previous answer streams', async () => {
  const h = harness([
    { id: 'q', role: 'user', content: 'What is Java?' },
    { id: 'a', role: 'assistant', content: '', streaming: true },
  ]);
  h.controller.start();
  h.controller.previous(5000);
  await h.controller.handleSpeechStart();
  assert.equal(h.state().conversation.filter(m => m.role === 'user').length, 1);
  h.controller.voiced(600);
  await h.controller.doEndUtterance();
  assert.equal(h.calls[0][0], 'Why?');
  assert.notEqual(h.calls[0][1], 'q');
  assert.equal(h.calls[0][2], false);
});

test('non-Latin speech and ordinary sounds cannot submit or replace an answer', async () => {
  for (const text of ['नमस्ते', 'తెలుగు మాటలు', '你好', 'Explain यह',
    '12345', '♪ ♫', 'Coughing.', 'Background noise', 'Sound of laughter',
    'Music', 'Ha ha ha!', 'Beep beep', '[door closes]', '(laughing)']) {
    for (const base of ['', 'Explain closures']) {
      const h = harness([
        { id: 'q', role: 'user', content: base || text },
        { id: 'a', role: 'assistant', content: 'Existing answer', streaming: true },
      ]);
      await h.controller.handleTranscript(text, 'q', base);
      assert.equal(h.calls.length, 0, text);
      assert.equal(h.state().conversation.find(m => m.id === 'a').content, 'Existing answer');
      if (base) assert.equal(h.state().conversation.find(m => m.id === 'q').content, base);
    }
  }
});

test('English technical terms and questions about sounds remain valid', async () => {
  for (const text of ['Explain noise cancellation', 'How does music streaming work?',
    'C++', 'C#', 'SQL', 'Node.js', 'Explain naïve Bayes', 'What is UTF-8?']) {
    const h = harness();
    await h.controller.handleTranscript(text, 'q', '');
    assert.equal(h.calls[0][0], text);
  }
});

test('resuming after two or three seconds regenerates the same punctuated question', async () => {
  for (const age of [2000, 3000]) {
    const h = harness([
      { id: 'q', role: 'user', content: 'What is Java?' },
      { id: 'a', role: 'assistant', content: 'Existing answer', streaming: true },
    ]);
    h.controller.start();
    h.controller.previous(age);
    await h.controller.handleSpeechStart();
    h.controller.voiced(600);
    await h.controller.doEndUtterance();
    assert.equal(h.calls[0], 'cancel');
    assert.equal(h.calls[1][0], 'What is Java? Why?');
    assert.equal(h.calls[1][1], 'q');
    assert.equal(h.calls[1][2], true);
    assert.equal(h.state().conversation.length, 2);
  }
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
