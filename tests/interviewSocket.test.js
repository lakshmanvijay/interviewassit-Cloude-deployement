const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const sockets = [], timers = new Map();
  let nextTimer = 0;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose(); }
    message(data) { this.onmessage({ data: JSON.stringify(data) }); }
  }
  const context = {
    module: { exports: {} }, WebSocket: Socket,
    require: () => ({ ipcRenderer: { invoke: async key => key === 'get-session-token' ? 'token' : 'ws://test' } }),
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/lib/interviewSocket.js'), 'utf8'), context);
  return { api: context.module.exports, sockets, timers };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('concurrent answers share one handshake and route their own chunks', async () => {
  const h = harness();
  const first = h.api.askBackend('first', () => {});
  const second = h.api.askBackend('second', () => {});
  await tick();
  assert.equal(h.sockets.length, 1);
  h.sockets[0].open();
  const a = await first, b = await second;
  h.sockets[0].message({ type: 'chunk', id: b.id, content: 'B' });
  h.sockets[0].message({ type: 'chunk', id: a.id, content: 'A' });
  h.sockets[0].message({ type: 'done', id: a.id });
  h.sockets[0].message({ type: 'done', id: b.id });
  assert.equal(await a.promise, 'A');
  assert.equal(await b.promise, 'B');
});

test('a stream that stalls after its first chunk still times out', async () => {
  const h = harness();
  const request = h.api.askBackend('question', () => {});
  await tick(); h.sockets[0].open();
  const answer = await request;
  h.sockets[0].message({ type: 'chunk', id: answer.id, content: 'partial' });
  assert.equal(h.timers.size, 1);
  const rejected = assert.rejects(answer.promise, /taking longer/);
  [...h.timers.values()][0]();
  await rejected;
});

test('disconnect during token lookup cannot open a late socket', async () => {
  const h = harness();
  const request = h.api.connect();
  h.api.disconnect();
  await assert.rejects(request, /Signed out/);
  assert.equal(h.sockets.length, 0);
});
