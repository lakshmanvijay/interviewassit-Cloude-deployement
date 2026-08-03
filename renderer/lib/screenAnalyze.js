const { ipcRenderer } = require('electron');

// Streams a Groq Vision answer for one or more screenshots. `onChunk` is
// called with the accumulated text on each delta; resolves with the final
// text (or rejects with an Error) when the stream ends.
function screenAnalyze(images, text, onChunk) {
  return new Promise((resolve, reject) => {
    const id = 'sa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    let accumulated = '';

    const onDelta = (_, p) => {
      if (p.id !== id) return;
      accumulated += p.delta;
      onChunk(accumulated);
    };
    const onDone = (_, p) => { if (p.id !== id) return; cleanup(); resolve(accumulated); };
    const onError = (_, p) => { if (p.id !== id) return; cleanup(); reject(new Error(p.error)); };

    function cleanup() {
      ipcRenderer.removeListener('screen-analyze-chunk', onDelta);
      ipcRenderer.removeListener('screen-analyze-done',  onDone);
      ipcRenderer.removeListener('screen-analyze-error', onError);
    }

    ipcRenderer.on('screen-analyze-chunk', onDelta);
    ipcRenderer.on('screen-analyze-done',  onDone);
    ipcRenderer.on('screen-analyze-error', onError);

    ipcRenderer.send('screen-analyze', { id, images, text });
  });
}

module.exports = { screenAnalyze };
