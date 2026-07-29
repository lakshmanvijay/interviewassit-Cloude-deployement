// Status-banner helpers shared by the chat, voice and screenshot flows.
function createWarningController(store) {
  let bannerTimer = null;

  function showWarning(msg) {
    store.setState({ warning: msg || '' });
  }

  // Brief banner that auto-dismisses after 4s.
  function showOnScreen(msg) {
    showWarning(msg);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => showWarning(''), 4000);
  }

  return { showWarning, showOnScreen };
}

module.exports = { createWarningController };
