// Shared "current question" pin/toggle logic. "Current question" is always
// the most recent user message, matching VoiceBar.js's 📌 button — used both
// by that button and by the global-shortcut IPC listeners in App.js so
// pressing a shortcut behaves identically to clicking the corresponding
// button.
function getCurrentQuestionId(store) {
  const lastUser = [...store.getState().conversation].reverse().find(m => m.role === 'user');
  return lastUser ? lastUser.id : null;
}

// Pins the current question (adding a new tab) if it isn't pinned yet, and
// makes sure its panel is open either way. Mirrors VoiceBar.js's pin button:
// never closes an already-open panel, only pins/opens.
function pinCurrentQuestion(store) {
  const id = getCurrentQuestionId(store);
  if (!id) return;
  const { pinnedIds: ids, openPinnedIds: open } = store.getState();
  if (ids.includes(id)) {
    if (!open.includes(id)) store.setState({ openPinnedIds: [...open, id] });
    return;
  }
  store.setState({ pinnedIds: [...ids, id], openPinnedIds: [...open, id] });
}

// Opens/minimizes the current question's pinned tab — mirrors clicking that
// tab in PinnedTabs.js. No-op if the current question was never pinned
// (nothing to toggle; use pinCurrentQuestion for that).
function toggleCurrentPinnedPanel(store) {
  const id = getCurrentQuestionId(store);
  if (!id) return;
  const { pinnedIds: ids, openPinnedIds: open } = store.getState();
  if (!ids.includes(id)) return;
  store.setState({
    openPinnedIds: open.includes(id) ? open.filter(x => x !== id) : [...open, id],
  });
}

module.exports = { getCurrentQuestionId, pinCurrentQuestion, toggleCurrentPinnedPanel };
