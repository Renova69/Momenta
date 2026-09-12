import { Photo } from '../types';
import { STORAGE_KEYS } from './storageKeys';

/**
 * The localStorage cache of an event's photo list, and the one place that
 * writes it.
 *
 * H1 — a freshly captured photo carries its compressed 1600px copy inline as
 * a base64 `data:` URL (300KB-1MB), because that is what POST /api/photos
 * takes and what the optimistic feed card renders before the upload lands.
 * The origin's whole localStorage quota is ~5MB, so a bulk capture exhausts
 * it within a handful of photos — and with moderation on, the quarantine
 * branch keeps those previews indefinitely rather than swapping in a server
 * URL.
 *
 * The previous write path caught the quota error and, for any list under 50
 * entries, gave up and wrote nothing. Since every read goes back through
 * localStorage, the photo the guest had just taken disappeared from their own
 * feed while its upload was still succeeding in the background — data loss as
 * far as the guest could tell, at the busiest moment of the event.
 *
 * Two rules come out of that:
 *
 *   1. The *record* is never negotiable. Losing a row loses the photo from
 *      the feed; losing its inline preview only degrades a thumbnail that the
 *      server is about to replace with a real URL anyway.
 *   2. Shed previews oldest-first, and only as far as the quota actually
 *      demands — not down to a fixed arbitrary count.
 *
 * What is shed from storage is still held in memory for the rest of the
 * session (see {@link rememberPendingPreview}), so nothing visibly degrades
 * for the guest who took the photo.
 */

/** Below this, trimming records is pointless — the list is not what is too big. */
const MIN_RETAINED_PHOTOS = 10;

/**
 * Session-only previews for photos still awaiting their server round-trip,
 * keyed by the optimistic local id. Never serialized: this Map existing is
 * what lets {@link persistPhotos} drop an inline `data:` URL from storage
 * without the feed card going blank.
 */
const pendingPreviews = new Map<string, { fullUrl: string; thumbnailUrl: string }>();

/**
 * Bound on the in-memory previews. A long reception on one device would
 * otherwise accumulate every capture's base64 copy in heap for the life of
 * the tab. Map iterates in insertion order, so the oldest goes first.
 */
const MAX_PENDING_PREVIEWS = 30;

function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:');
}

/** Hold a capture's preview in memory so storage is free to drop it. */
export function rememberPendingPreview(
  localId: string,
  preview: { fullUrl: string; thumbnailUrl: string }
): void {
  if (!localId) return;
  if (pendingPreviews.size >= MAX_PENDING_PREVIEWS) {
    const oldest = pendingPreviews.keys().next();
    if (!oldest.done) pendingPreviews.delete(oldest.value);
  }
  pendingPreviews.set(localId, preview);
}

/** Release a preview once a real, reachable URL has taken its place. */
export function forgetPendingPreview(localId: string): void {
  pendingPreviews.delete(localId);
}

/** Test seam — drop every in-memory preview. */
export function clearPendingPreviews(): void {
  pendingPreviews.clear();
}

/**
 * Read an event's cached photos, putting back any preview that was shed from
 * storage to fit the quota.
 *
 * A stored URL always wins: once the upload lands, `fullUrl` is the server's
 * own URL and the in-memory copy is stale.
 */
export function readPhotos(eventId: string): Photo[] {
  let list: Photo[];
  try {
    const data = localStorage.getItem(STORAGE_KEYS.PHOTOS(eventId));
    list = data ? (JSON.parse(data) as Photo[]) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(list) || pendingPreviews.size === 0) return list;

  return list.map((photo) => {
    const preview = pendingPreviews.get(photo.id);
    if (!preview) return photo;
    return {
      ...photo,
      fullUrl: photo.fullUrl || preview.fullUrl,
      thumbnailUrl: photo.thumbnailUrl || preview.thumbnailUrl,
    };
  });
}

/**
 * Drop the inline preview of the oldest photo that still carries one.
 * Returns null when there is nothing left to shed.
 *
 * The list is newest-first (addPhoto prepends), so the oldest entry is at the
 * end — which is also the one whose preview the guest is least likely to be
 * looking at.
 */
function shedOldestPreview(list: Photo[]): Photo[] | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const photo = list[i];
    if (!isDataUrl(photo.fullUrl) && !isDataUrl(photo.thumbnailUrl) && !isDataUrl(photo.originalUrl)) {
      continue;
    }
    const lighter = [...list];
    lighter[i] = {
      ...photo,
      fullUrl: isDataUrl(photo.fullUrl) ? '' : photo.fullUrl,
      thumbnailUrl: isDataUrl(photo.thumbnailUrl) ? '' : photo.thumbnailUrl,
      originalUrl: isDataUrl(photo.originalUrl) ? null : photo.originalUrl,
    };
    return lighter;
  }
  return null;
}

/**
 * Write an event's photo list, shedding weight only as far as the quota
 * forces. Records are given up last, and never below MIN_RETAINED_PHOTOS.
 */
export function persistPhotos(eventId: string, list: Photo[]): void {
  let candidate = Array.isArray(list) ? list : [];

  for (;;) {
    try {
      localStorage.setItem(STORAGE_KEYS.PHOTOS(eventId), JSON.stringify(candidate));
      return;
    } catch {
      const lighter = shedOldestPreview(candidate);
      if (lighter) {
        candidate = lighter;
        continue;
      }

      // No inline previews left: the list itself is too long for the quota.
      // Halving converges quickly and keeps the newest entries, which are the
      // ones the feed shows first.
      if (candidate.length > MIN_RETAINED_PHOTOS) {
        candidate = candidate.slice(0, Math.max(MIN_RETAINED_PHOTOS, Math.floor(candidate.length / 2)));
        continue;
      }

      console.warn(
        `[PhotoStore] Could not cache ${candidate.length} photo(s) for event ${eventId}: ` +
          'localStorage is full even with every inline preview removed. The feed will be ' +
          'served from the server on the next sync.'
      );
      return;
    }
  }
}
