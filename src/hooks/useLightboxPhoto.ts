import { useCallback, useMemo, useState } from 'react';
import { Photo } from '../types';

/**
 * The photo open in the lightbox, read from the live list (N-113).
 *
 * The lightbox used to hold a copy of the photo taken when it opened. A like,
 * a reaction or a comment made inside it reached the server and the feed but
 * never the open dialog, so a posted comment appeared only after closing and
 * reopening — and a guest who thought it had failed posted it again. Only the
 * id is kept now; the photo is whatever the album holds under it, and a photo
 * deleted while open closes the dialog.
 */
export function useLightboxPhoto(photos: Photo[]) {
  const [openId, setOpenId] = useState<string | null>(null);
  const photo = useMemo(
    () => (openId ? (photos.find((candidate) => candidate.id === openId) ?? null) : null),
    [openId, photos]
  );
  const open = useCallback((chosen: Photo) => setOpenId(chosen.id), []);
  const close = useCallback(() => setOpenId(null), []);
  return { photo, open, close };
}
