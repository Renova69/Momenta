import { useState, useRef, useEffect, useCallback } from 'react';

const DEFAULT_DELAY_MS = 500;

/**
 * Local, responsive input state that commits to the server only after the
 * user stops typing. Firing a network call on every keystroke was the bug:
 * a 20-character venue name meant 20 concurrent PUT requests racing each
 * other, and the last one to arrive silently won regardless of typing order.
 *
 * `delayMs: null` commits only when `flush` is called (or on unmount) — for a
 * field where every commit is a consequence of its own, like the album's
 * address, where each one is a permanent rename (N-62).
 */
export function useDebouncedField<T>(
  externalValue: T,
  onCommit: (value: T) => void,
  delayMs: number | null = DEFAULT_DELAY_MS
): [T, (value: T) => void, () => void] {
  const [value, setValue] = useState(externalValue);
  // What we last committed (or adopted from outside) — distinguishes a
  // genuine external change (switching events, a server-rejected edit
  // reverting) from the echo of our own debounced commit.
  const lastKnown = useRef(externalValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // onCommit is typically a fresh closure every render (it captures other
  // current props) — read the latest one from a ref inside the timeout
  // rather than baking a possibly-stale one into a memoized callback.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  // FE-08: tracks the latest not-yet-committed value so unmount can flush
  // it instead of dropping it — the effect cleanup below has an empty
  // dependency array, so it can only see fresh state through a ref.
  const pendingValueRef = useRef(externalValue);
  const hasPendingRef = useRef(false);

  useEffect(() => {
    if (externalValue !== lastKnown.current) {
      lastKnown.current = externalValue;
      setValue(externalValue);
    }
  }, [externalValue]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // Switching tabs or navigating away mid-debounce used to silently
      // drop the last keystrokes typed before the timer had a chance to
      // fire — commit them now instead of losing the draft.
      if (hasPendingRef.current) {
        hasPendingRef.current = false;
        onCommitRef.current(pendingValueRef.current);
      }
    };
  }, []);

  const update = useCallback((next: T) => {
    setValue(next);
    pendingValueRef.current = next;
    hasPendingRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (delayMs === null) return;
    timerRef.current = setTimeout(() => {
      lastKnown.current = next;
      hasPendingRef.current = false;
      onCommitRef.current(next);
    }, delayMs);
  }, [delayMs]);

  /** Commit now whatever is pending, if anything is. */
  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!hasPendingRef.current) return;
    hasPendingRef.current = false;
    lastKnown.current = pendingValueRef.current;
    onCommitRef.current(pendingValueRef.current);
  }, []);

  return [value, update, flush];
}
