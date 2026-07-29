// Jump / prev / next across question ("user" message) bubbles. Operates
// directly on the rendered DOM (scroll position + a CSS flash animation)
// since that's inherently imperative regardless of the view layer.
function createQuestionNav(store, getContainer) {
  function getUserQuestionElements() {
    const container = getContainer();
    if (!container) return [];
    return Array.from(container.querySelectorAll('.message.user'));
  }

  function getCurrentQuestionIndex() {
    const msgs = getUserQuestionElements();
    if (!msgs.length) return -1;

    const container = getContainer();
    const anchor = container.scrollTop + 12;
    let bestIndex = -1;
    let bestDistance = Infinity;

    msgs.forEach((msg, idx) => {
      const distance = Math.abs(msg.offsetTop - anchor);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = idx;
      }
    });

    return bestIndex;
  }

  function updateCurrentQuestionFromViewport() {
    const idx = getCurrentQuestionIndex();
    if (idx >= 0) store.setState({ navIndex: idx });
    return idx;
  }

  function flashTarget(el) {
    document.querySelectorAll('.message.nav-focus').forEach(node => {
      node.classList.remove('nav-focus');
      void node.offsetWidth; // force reflow so animation restarts
    });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('nav-focus');
  }

  function jumpToQuestion(index) {
    const msgs = getUserQuestionElements();
    if (!msgs.length) return;
    const safeIndex = Math.max(0, Math.min(msgs.length - 1, index));
    store.setState({ navIndex: safeIndex });
    flashTarget(msgs[safeIndex]);
  }

  function navigateQuestion(dir) {
    const msgs = getUserQuestionElements();
    if (!msgs.length) return;

    const currentIndex = store.getState().navIndex >= 0
      ? store.getState().navIndex
      : updateCurrentQuestionFromViewport();
    const startIndex = currentIndex >= 0 ? currentIndex : (dir < 0 ? msgs.length - 1 : 0);
    const nextIndex = Math.max(0, Math.min(msgs.length - 1, startIndex + dir));
    store.setState({ navIndex: nextIndex });
    flashTarget(msgs[nextIndex]);
  }

  function attachScrollListener() {
    const container = getContainer();
    if (!container) return () => {};
    let rafId = null;
    const onScroll = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateCurrentQuestionFromViewport);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }

  return { jumpToQuestion, navigateQuestion, attachScrollListener };
}

module.exports = { createQuestionNav };
