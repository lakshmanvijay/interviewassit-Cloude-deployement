// ── CRASH RESILIENCE (renderer) ─────────────────────
// Mirrors the guards main.js installs for the main process (see its own
// "CRASH RESILIENCE" comment). This window runs with nodeIntegration: true,
// so it has a real Node `process` alongside the usual browser `window` —
// without a handler, an uncaught exception or unhandled promise rejection
// here (a bad IPC round trip, a network call that rejects somewhere not
// awaited, anything) crashes this renderer process outright under Node's
// default behavior. Since this is the app's only window, that's exactly
// what "the app just closed for no reason" looks like from the outside.
// Installed before requiring App.js so it's active for every module's
// top-level code too, not just what runs after mount.
window.addEventListener('error', event => {
  console.error('[fatal] uncaught error (window kept running):', event.error || event.message);
});
window.addEventListener('unhandledrejection', event => {
  console.error('[fatal] unhandled promise rejection (window kept running):', event.reason);
  event.preventDefault();
});
if (typeof process !== 'undefined' && process.on) {
  process.on('uncaughtException', err => {
    console.error('[fatal] uncaught exception (renderer kept running):', err);
  });
  process.on('unhandledRejection', reason => {
    console.error('[fatal] unhandled promise rejection (renderer kept running):', reason);
  });
}

const { render, html } = require('./html');
const { store } = require('./store');
const { App } = require('./App');

render(html`<${App} store=${store} />`, document.getElementById('root'));
