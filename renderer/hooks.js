const { useState, useEffect, useRef } = require('preact/hooks');

// Subscribes a component to one slice of the store. The component only
// re-renders when `selector(state)` changes (by reference, or `isEqual`).
function useStoreSlice(store, selector, isEqual) {
  const eq = isEqual || Object.is;
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const [slice, setSlice] = useState(() => selectorRef.current(store.getState()));
  const sliceRef = useRef(slice);
  sliceRef.current = slice;

  useEffect(() => {
    // Selector may have changed between render and effect commit — re-sync.
    const current = selectorRef.current(store.getState());
    if (!eq(current, sliceRef.current)) {
      sliceRef.current = current;
      setSlice(current);
    }
    return store.subscribe(state => {
      const next = selectorRef.current(state);
      if (!eq(next, sliceRef.current)) {
        sliceRef.current = next;
        setSlice(next);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  return slice;
}

// Ticks an ISO-timestamp store field down into an "Xh Ym left" label. Used
// for both store.assistExpiresAt (a paid Live Assist window — set once POST
// /api/sessions/start succeeds) and store.trialExpiresAt (a free trial —
// set once POST /api/sessions/trial/start succeeds, see App.js's
// startTrial()); pass `field` to pick which. null/past means no active
// window. Shared by EmptyState.js (pre-session countdown card) and
// TitleBar.js (the in-session timer badge, which turns red in the last 5
// minutes — see overlay.html's .assist-timer.critical).
function useAssistCountdown(store, field = 'assistExpiresAt') {
  const expiresAtRaw = useStoreSlice(store, s => s[field]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!expiresAtRaw) return;
    const expiresAt = new Date(expiresAtRaw).getTime();
    let timeoutId;
    // Self-rescheduling instead of a fixed setInterval: 30s ticks are plenty
    // while there's minutes left to show, but the last 60s switches to a
    // seconds countdown (see underOneMinute below), which needs a 1s tick to
    // actually look like it's counting down instead of jumping.
    function schedule() {
      const msLeft = expiresAt - Date.now();
      const delay = msLeft <= 60000 ? 1000 : 30000;
      timeoutId = setTimeout(() => { setNow(Date.now()); schedule(); }, delay);
    }
    // `now` was captured once at mount (useState(Date.now())) and this
    // effect only re-runs when expiresAtRaw itself changes — i.e. whenever a
    // trial/assist window actually starts. Without refreshing `now` here
    // too, a component that mounted (e.g. TitleBar, present from app
    // launch) minutes before the window started keeps showing that stale
    // mount-time `now`, inflating the displayed remaining time by however
    // long the app had been idle — a 10-minute trial started 2 minutes after
    // launch would read "12m" until the first scheduled tick corrects it.
    setNow(Date.now());
    schedule();
    return () => clearTimeout(timeoutId);
  }, [expiresAtRaw]);

  if (!expiresAtRaw) return null;
  const expiresAt = new Date(expiresAtRaw).getTime();
  if (!expiresAt || expiresAt <= now) return null;

  const msLeft = expiresAt - now;
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  const underOneMinute = msLeft < 60000;
  // totalMinutes rounds up (never shows 0m while time is technically still
  // left) — used by TitleBar's compact minutes-only badge; label keeps the
  // "Xh Ym" split for places that want it (EmptyState's pre-session card).
  const totalMinutes = Math.max(1, Math.ceil(msLeft / 60000));
  // totalSeconds only matters once underOneMinute — TitleBar switches its
  // badge to "Ns" instead of "1m" for that last stretch.
  const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
  return { h, m, totalMinutes, totalSeconds, underOneMinute, label: `${h}h ${m}m`, critical: h === 0 && m <= 5 };
}

module.exports = { useStoreSlice, useAssistCountdown };
