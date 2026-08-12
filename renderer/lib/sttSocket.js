const { ipcRenderer } = require('electron');

// ── LIVE STT WEBSOCKET (one connection per utterance) ─────────────
// Backend opens a fresh Deepgram bridge per /ws/stt connection — so this
// opens a new socket per VAD-detected utterance, streams raw PCM16LE mono
// 16kHz binary frames as they're captured, and resolves with the
// accumulated final transcript once the server acks "stop" and closes.

const READY_TIMEOUT_MS = 8000;
const FINALIZE_TIMEOUT_MS = 8000;
// If finish() is called while the socket is still mid-handshake, how much
// longer we'll wait for "ready" before giving up on this utterance. Kept
// short and separate from READY_TIMEOUT_MS: by the time finish() runs, the
// connect has usually already had the whole speech+silence window (1-2s+)
// to complete, so if it's still not ready, blocking the UI for the full
// connect timeout (8s) is worse than just failing this utterance fast.
const FINALIZE_READY_GRACE_MS = 1200;

// Returns a session object before the connection is even open. sendAudio()
// is safe to call right away — audio sent before the server acks "ready" is
// queued internally and flushed the instant it does, so callers don't need
// to track connection state or buffer audio themselves.
function connectSttSession(language) {
  let ws = null;
  let readyResolve, readyReject;
  let readySettled = false;
  const readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  // finish() always awaits this itself; without a no-op handler here, a
  // rejection (e.g. connect timeout) before anyone else awaits it would
  // surface as an unhandled promise rejection.
  readyPromise.catch(() => {});

  let closeResolve = null;
  const closedPromise = new Promise(res => { closeResolve = res; });

  let finalText = '';
  let errorMessage = null;
  let serverReady = false;
  // Audio captured before the server acks "ready" (token/URL IPC round
  // trips + WS handshake + the backend's own handshake with its STT
  // provider can easily take over a second) is queued here and flushed the
  // instant we're ready, so the caller can call sendAudio() from the first
  // moment it starts capturing without worrying about connection state.
  const outgoingQueue = [];

  (async () => {
    const [token, wsUrl] = await Promise.all([
      ipcRenderer.invoke('get-session-token'),
      ipcRenderer.invoke('get-ws-url', '/ws/stt'),
    ]);
    if (!token || !wsUrl) { readySettled = true; readyReject(new Error('Not signed in')); return; }

    const url = `${wsUrl}?token=${encodeURIComponent(token)}&language=${encodeURIComponent(language || 'en')}`;
    console.log('[stt] connecting:', wsUrl, '(token present:', !!token, ')');
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    ws = socket;

    const readyTimer = setTimeout(() => {
      if (readySettled) return;
      console.warn('[stt] never received "ready" within', READY_TIMEOUT_MS, 'ms — closing');
      readySettled = true;
      readyReject(new Error('STT connection timed out'));
    }, READY_TIMEOUT_MS);

    socket.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) {
        console.warn('[stt] non-JSON message ignored:', typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)');
        return;
      }
      console.log('[stt] recv:', msg.type, msg.type === 'transcript' ? `"${msg.text}" isFinal=${msg.isFinal}` : msg.message || '');

      if (msg.type === 'ready') {
        clearTimeout(readyTimer);
        serverReady = true;
        if (outgoingQueue.length) {
          console.log('[stt] flushing', outgoingQueue.length, 'chunks buffered during connect');
          outgoingQueue.forEach(buf => socket.send(buf));
          outgoingQueue.length = 0;
        }
        readySettled = true;
        readyResolve();
      } else if (msg.type === 'transcript') {
        // Interim (isFinal:false) results are revised as more audio comes
        // in — Deepgram supersedes them, so only finalized segments are
        // accumulated into the text this session ultimately resolves with.
        if (msg.isFinal && msg.text) {
          finalText = finalText ? `${finalText} ${msg.text}`.trim() : msg.text;
        }
      } else if (msg.type === 'error') {
        errorMessage = msg.message || 'STT error';
      }
    };

    socket.onerror = err => {
      console.error('[stt] socket error:', err.message || err);
      clearTimeout(readyTimer);
      if (!readySettled) { readySettled = true; readyReject(new Error('STT connection failed')); }
    };

    socket.onclose = event => {
      console.log('[stt] closed: code=', event.code, 'reason=', event.reason || '(none)', 'clean=', event.wasClean);
      clearTimeout(readyTimer);
      if (!readySettled) { readySettled = true; readyReject(new Error('STT connection closed before ready')); }
      closeResolve();
    };
  })();

  return {
    ready: () => readyPromise,

    // Safe to call any time, even before the server has acked "ready" —
    // audio is queued and flushed automatically the instant it does, so
    // callers don't need to track connection state themselves.
    sendAudio(pcm16Buffer) {
      if (serverReady && ws && ws.readyState === WebSocket.OPEN) ws.send(pcm16Buffer);
      else outgoingQueue.push(pcm16Buffer);
    },

    // Signals end of speech, waits for the server to finish finalizing and
    // close the socket (or a timeout, so a stuck server can't hang the
    // caller forever), and returns whatever text accumulated.
    async finish() {
      // If the socket is still mid-handshake, give it a brief chance to open
      // and flush any queued audio before finalizing — otherwise a slow
      // connect means the entire utterance is silently dropped: finish()
      // would return empty text without ever sending "stop" because ws
      // isn't OPEN yet, and the socket would be left dangling since nothing
      // else closes it. Bounded to a short grace period, not the full
      // connect timeout — see FINALIZE_READY_GRACE_MS.
      if (!readySettled) {
        try {
          await Promise.race([
            readyPromise,
            new Promise(res => setTimeout(res, FINALIZE_READY_GRACE_MS)),
          ]);
        } catch (e) { /* connect failed — fall through and clean up below */ }
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (ws && ws.readyState === WebSocket.CONNECTING) { try { ws.close(); } catch (e) {} }
        return { text: finalText, error: errorMessage };
      }
      try { ws.send(JSON.stringify({ type: 'stop' })); } catch (e) {}
      await Promise.race([
        closedPromise,
        new Promise(res => setTimeout(res, FINALIZE_TIMEOUT_MS)),
      ]);
      if (ws && ws.readyState !== WebSocket.CLOSED) { try { ws.close(); } catch (e) {} }
      return { text: finalText, error: errorMessage };
    },

    // Hard-stop with no attempt to finalize — used when the user toggles
    // listening off mid-utterance.
    abort() {
      if (ws) { try { ws.close(); } catch (e) {} }
    },
  };
}

module.exports = { connectSttSession };
