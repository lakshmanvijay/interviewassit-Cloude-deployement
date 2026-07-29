const { ipcRenderer } = require('electron');

// ── CEREBRAS STREAMING (IPC) ───────────────────
function cerebrasChat(messages, model, onDelta) {
  return new Promise((resolve, reject) => {
    const id  = 'cereq_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    let   acc = '';

    // Give slower models more breathing room before we treat the request as failed.
    let timer = setTimeout(() => {
      cleanup();
      reject(new Error('The model is taking longer than expected. The service may be busy — please wait a moment and try again.'));
    }, 45000);

    const onChunk = (_, p) => {
      if (p.id !== id) return;
      clearTimeout(timer); timer = null;
      acc += p.delta; onDelta(acc);
    };
    const onDone = (_, p) => { if (p.id !== id) return; cleanup(); resolve(acc); };
    const onErr  = (_, p) => { if (p.id !== id) return; cleanup(); reject(new Error(p.error)); };

    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      ipcRenderer.removeListener('cerebras-chunk', onChunk);
      ipcRenderer.removeListener('cerebras-done',  onDone);
      ipcRenderer.removeListener('cerebras-error', onErr);
    }

    ipcRenderer.on('cerebras-chunk', onChunk);
    ipcRenderer.on('cerebras-done',  onDone);
    ipcRenderer.on('cerebras-error', onErr);

    ipcRenderer.send('cerebras-chat', { id, model, messages });
  });
}

module.exports = { cerebrasChat };
