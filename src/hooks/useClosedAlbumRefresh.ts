import { useEffect } from 'react';

/** How often a closed album is re-read while its page is open. */
export const CLOSED_ALBUM_REFRESH_MS = 60_000;

/**
 * N-183 — while the album shown is closed, re-read it every minute and
 * whenever the page comes back into view. A purchase that reopens an album
 * sends nothing to guests whose page is already open, so they kept the
 * closed notice and the blocked camera until they reloaded.
 */
export function useClosedAlbumRefresh(closedAt: string | null, refresh: () => Promise<void> | void): void {
  useEffect(() => {
    if (!closedAt) return undefined;
    const run = () => {
      void refresh();
    };
    const timer = setInterval(run, CLOSED_ALBUM_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [closedAt, refresh]);
}
