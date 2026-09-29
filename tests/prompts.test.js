const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const prompts = require('../renderer/lib/prompts');

const resume = 'Developed Java services at Example Ltd.';
const profile = { role: 'Backend Developer', mode: 'general' };

test('both prompt paths require a real role and loaded resume', () => {
  for (const [text, candidate] of [['', profile], [resume, null], ['  ', { role: ' ' }]]) {
    assert.ok(prompts.getContextIssue(text, candidate));
    assert.throws(() => prompts.getSystemPrompt(text, 'basic', candidate));
    assert.throws(() => prompts.getScreenAnalyzePrompt(text, candidate));
  }
  assert.equal(prompts.getContextIssue(resume, profile), '');
});

test('text and screenshot prompts share scope and ignore saved general mode', () => {
  assert.deepEqual(Object.keys(prompts.SYSTEM_PROMPTS), ['interview']);
  for (const prompt of [
    prompts.getSystemPrompt(resume, 'basic', profile),
    prompts.getScreenAnalyzePrompt(resume, profile),
  ]) {
    assert.ok(prompt.includes('MANDATORY ANSWER SCOPE'));
    assert.ok(prompt.includes(profile.role));
    assert.ok(prompt.includes(resume));
    assert.ok(prompt.includes('resume only'));
    assert.ok(!prompt.includes('You are a concise assistant'));
    assert.ok(!prompt.includes('saved mode preference'));
  }
});

test('screenshot requests fail before contacting backend if context is missing', async () => {
  const requests = [];
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === './prompts') return prompts;
      if (name === './interviewSocket') return { askBackend(...args) {
        requests.push(args);
        return Promise.resolve({ promise: Promise.resolve('answer') });
      } };
      throw new Error(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/lib/screenAnalyze.js'), 'utf8'), context);
  const { screenAnalyze } = context.module.exports;
  assert.throws(() => screenAnalyze(['image'], '', '', profile, () => {}));
  assert.equal(requests.length, 0);
  await screenAnalyze(['image'], '', resume, profile, () => {});
  assert.equal(requests.length, 1);
  assert.ok(requests[0][0].includes('MANDATORY ANSWER SCOPE'));
  assert.ok(!requests[0][0].includes('Also solve any'));
});

test('mixed role and resume technologies retain contextual transcript recovery in both paths', () => {
  const sapResume = 'SAP CPI integration experience';
  const sapProfile = { role: 'SAP MM' };
  for (const prompt of [
    prompts.getSystemPrompt(sapResume, 'intermediate', sapProfile),
    prompts.getScreenAnalyzePrompt(sapResume, sapProfile),
  ]) {
    assert.ok(prompt.includes('alternative sources of relevance'));
    assert.ok(prompt.includes('Interpret imperfect interview transcripts BEFORE deciding relevance'));
    assert.ok(prompt.includes('Never respond with a request to justify relevance'));
    assert.ok(prompt.includes('SAP CPI integration experience'));
    assert.ok(prompt.includes('Target role: SAP MM'));
    assert.ok(!prompt.includes('If relevance is unclear, ask briefly how'));
  }
});
