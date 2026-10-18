import { useSyncExternalStore } from 'react';
import { i18n } from '../i18n';

/**
 * Re-render the calling component when the language changes, and answer the
 * current language.
 *
 * N-184 — a memoized component (React.memo) re-renders only when its props
 * change, and switching the language changes none, so the photo cards kept
 * every word in the language they were first drawn in. Calling this inside
 * one subscribes it to the switch itself.
 */
export function useLanguage(): string {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

function subscribe(onChange: () => void): () => void {
  const unsubscribe = i18n.subscribe(onChange);
  return () => {
    unsubscribe();
  };
}

function getLanguage(): string {
  return i18n.getLanguage();
}
