// Waits two animation frames (enough for Preact's batched render to commit)
// before scrolling, matching the timing the original imperative version relied on.
//
// `getEl` must be a function, not a resolved element — the element usually
// doesn't exist in the DOM yet at the moment this is called (Preact commits
// the new message asynchronously), so the lookup has to happen lazily,
// inside the delayed callback, once the DOM has actually caught up.
function scrollElIntoTop(getEl) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = getEl();
    if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
  }));
}

module.exports = { scrollElIntoTop };
