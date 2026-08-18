const { ipcRenderer } = require('electron');

// ── INTERVIEW ANSWERS WEBSOCKET ────────────────
// Streams LLM answers from our own backend (ws(s)://<host>/ws/interview)
// instead of calling Cerebras directly from this app. One persistent
// connection is reused across questions; each question is correlated by a
// client-generated id so chunks/done/error route back to the right caller.

const PING_INTERVAL_MS = 25000;
const REQUEST_TIMEOUT_MS = 45000;
const VISION_REQUEST_TIMEOUT_MS = 60000; // matches the old direct-Cerebras AbortController timeout in main.js
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let ws = null;
let connectPromise = null;
let pingTimer = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let intentionallyClosed = false;

// id -> { resolve, reject, onDelta, acc, timeoutTimer }
const pending = new Map();

function failAllPending(message) {
  for (const [id, p] of pending) {
    clearTimeout(p.timeoutTimer);
    p.reject(new Error(message));
  }
  pending.clear();
}

function scheduleReconnect() {
  if (intentionallyClosed || reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt++;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    // Only reconnect if we're still logged in — a logout in the meantime
    // means there's no token to reconnect with.
    const token = await ipcRenderer.invoke('get-session-token');
    if (token) connect().catch(() => {});
  }, delay);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return connectPromise;
  }

  intentionallyClosed = false;
  connectPromise = (async () => {
    const [token, wsUrl] = await Promise.all([
      ipcRenderer.invoke('get-session-token'),
      ipcRenderer.invoke('get-ws-url'),
    ]);
    if (!token || !wsUrl) throw new Error('Not signed in');

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);

      socket.onopen = () => {
        ws = socket;
        reconnectAttempt = 0;
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, PING_INTERVAL_MS);
        resolve();
      };

      socket.onmessage = event => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        const p = msg.id != null ? pending.get(msg.id) : null;

        if (msg.type === 'chunk' && p) {
          clearTimeout(p.timeoutTimer);
          p.acc += msg.content;
          p.onDelta(p.acc);
        } else if (msg.type === 'done' && p) {
          clearTimeout(p.timeoutTimer);
          pending.delete(msg.id);
          p.resolve(p.acc);
        } else if (msg.type === 'error' && p) {
          clearTimeout(p.timeoutTimer);
          pending.delete(msg.id);
          p.reject(new Error(msg.message || 'The backend reported an error'));
        }
        // 'pong' and errors with no matching id are just ignored.
      };

      socket.onerror = () => {
        // The 'close' handler (below) fires right after and does the actual
        // cleanup/reconnect — this just makes sure connect() rejects if the
        // very first handshake fails.
        reject(new Error('WebSocket connection failed'));
      };

      socket.onclose = () => {
        clearInterval(pingTimer);
        if (ws === socket) ws = null;
        // A question mid-stream when the socket drops is NOT retried — the
        // spec is explicit that re-send isn't automatic. Treat it as failed
        // and let the user re-ask.
        failAllPending('Connection lost — please try again');
        if (!intentionallyClosed) scheduleReconnect();
      };
    });
  })();

  return connectPromise;
}

function disconnect() {
  intentionallyClosed = true;
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  failAllPending('Signed out');
  if (ws) { ws.close(); ws = null; }
  connectPromise = null;
}

// Resolves with { id, promise } — `id` lets a caller cancel this exact
// in-flight question later (see cancelQuestion below), `promise` resolves
// with the full accumulated answer, calling onDelta(accumulatedTextSoFar) as
// chunks arrive — same shape the old cerebrasChat() used, just wrapped.
//
// `images` (optional array of base64 JPEG strings, no data-URL prefix) is
// for screenshot/vision requests — the backend routes these to gemma-4-31b
// instead of the regular text model. Vision requests can take longer than
// a plain question (multiple images to tile/tokenize), hence the longer
// timeout when images are present.
async function askBackend(question, onDelta, provider, images) {
  await connect();
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');

  const id = 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const timeoutMs = images && images.length ? VISION_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

  const promise = new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      pending.delete(id);
      ws.send(JSON.stringify({ type: 'cancel', id }));
      reject(new Error('The model is taking longer than expected. The service may be busy — please wait a moment and try again.'));
    }, timeoutMs);

    pending.set(id, { resolve, reject, onDelta, acc: '', timeoutTimer });

    const payload = { type: 'question', id, question };
    if (provider) payload.provider = provider;
    if (images && images.length) payload.images = images;
    ws.send(JSON.stringify(payload));
  });

  return { id, promise };
}

// Distinguishes a deliberate cancelQuestion() from a real backend/network
// failure, so callers (App.js) can suppress the "Error: ..." bubble for a
// question that was only abandoned because the interviewer kept talking and
// a fuller, combined question is about to replace it.
const CANCELLED_ERROR = 'CANCELLED';

// Abandons an in-flight question before it resolves — used when the
// interviewer resumes speaking mid-answer (see voice.js's continuation
// detection): this speculative answer is about to be superseded by a
// regenerated one using the fuller question, so there's no point letting it
// keep streaming/consuming tokens.
function cancelQuestion(id) {
  const p = pending.get(id);
  if (!p) return; // already resolved/rejected/never existed — nothing to do
  clearTimeout(p.timeoutTimer);
  pending.delete(id);
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'cancel', id })); } catch (e) {}
  }
  p.reject(new Error(CANCELLED_ERROR));
}

module.exports = { connect, disconnect, askBackend, cancelQuestion, CANCELLED_ERROR };
