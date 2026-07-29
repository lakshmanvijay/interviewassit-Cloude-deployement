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

module.exports = { useStoreSlice };
