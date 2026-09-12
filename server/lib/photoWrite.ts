/**
 * The part of writing a photo that both upload paths have to get right.
 *
 * A guest capture (`server/routes/photos/upload.ts`) and a photographer frame
 * (`server/lib/ingestPipeline.ts`) arrive completely differently — one is a
 * base64 data URL from a phone with a fingerprint-anchored guest identity, the
 * other a DSLR file over FTP or batch ingest attributed to a single dedicated
 * photographer row — and they write different columns. But once the bytes are
 * in hand the rules are identical, and they are the rules that cost money and
 * leak data when they drift:
 *
 * - **DB-05 — nothing is orphaned.** Files are written before the row that
 *   points at them can be committed, so every path is tracked and removed if
 *   the insert does not land. An orphan is invisible: once the row is gone,
 *   nothing knows the object exists, and it is billed forever.
 * - **SEC-D1 — the quota is re-checked under a lock.** Every earlier check ran
 *   against an unlocked SELECT, and decoding and resizing take real time, so a
 *   concurrent upload for the same event can land in between. This is the check
 *   that actually holds.
 * - **MED-03/SEC-M5 — a quarantined photo is never broadcast with its real
 *   URLs.** Hosts get a signed, host-scoped preview token instead; guests get
 *   nothing until it is approved or revealed.
 *
 * Both implementations previously carried their own copy of all three, and the
 * copies had already begun to diverge (see `savePhotoVariants` below).
 *
 * What stays with the callers: resolving who uploaded, choosing filenames, and
 * the INSERT column list. Those genuinely differ, and forcing them through one
 * signature would trade a real duplication for a worse abstraction.
 */

import { PoolClient } from 'pg';
import { pool } from './db';
import { storageAdapter, toAbsoluteUrl } from './storage';
import { buildPreviewUrl } from './photoQuarantine';
import { wsManager } from '../ws/wsServer';
import { errorLabel } from './errors';
import {
  getUploadContext,
  checkUploadAllowance,
  acquireEventUploadLock,
} from '../middleware/tierGate';

/** The event settings, plan allowance and usage that one round trip returns. */
export type UploadContext = NonNullable<Awaited<ReturnType<typeof getUploadContext>>>;

/** One stored rendition of a photo. The caller names the file. */
export interface PhotoVariant {
  buffer: Buffer;
  /** Full filename including extension — each path keeps its own convention. */
  filename: string;
  mimetype: string;
}

export interface PhotoVariants {
  /** What the feed shows. */
  display: PhotoVariant;
  /** What a feed card shows; always derived, never the display copy reused. */
  thumbnail: PhotoVariant;
  /** The untouched capture, kept for the high-resolution export. Optional. */
  original?: PhotoVariant;
}

interface SavedObject {
  publicUrl: string;
  storagePath: string;
}

export interface SavedPhotoFiles {
  display: SavedObject;
  thumbnail: SavedObject;
  original: SavedObject | null;
  /** Bytes charged against the plan: every rendition kept for this photo. */
  totalBytes: number;
  /**
   * Remove everything this call wrote. Safe to invoke more than once, and it
   * never throws — a cleanup failure is logged, because the caller is already
   * handling a more important failure.
   */
  cleanup: () => Promise<void>;
}

/**
 * Write a photo's renditions to storage, tracking every path for cleanup.
 *
 * All three are written concurrently. **If any one fails, the ones that
 * succeeded are deleted before the error propagates** — `Promise.all` alone
 * loses the successful writes' paths when a sibling rejects, and
 * `ingestPipeline.ts` had exactly that hole: it collected paths only from the
 * resolved array, which a rejection never produces. The guest path wrote
 * sequentially and so never hit it. Neither behaviour is preserved here; this
 * is correct for both.
 */
export async function savePhotoVariants(
  eventId: string,
  variants: PhotoVariants,
  needsQuarantine: boolean,
  logLabel: string
): Promise<SavedPhotoFiles> {
  const entries: [keyof PhotoVariants, PhotoVariant][] = [
    ['display', variants.display],
    ['thumbnail', variants.thumbnail],
  ];
  if (variants.original) entries.push(['original', variants.original]);

  const settled = await Promise.allSettled(
    entries.map(([, v]) =>
      storageAdapter.save(v.buffer, v.filename, v.mimetype, eventId, { quarantine: needsQuarantine })
    )
  );

  const written = settled
    .filter((r): r is PromiseFulfilledResult<SavedObject> => r.status === 'fulfilled')
    .map((r) => r.value);

  const removeAll = async (objects: SavedObject[]): Promise<void> => {
    await Promise.all(
      objects.map((o) =>
        storageAdapter.delete(o.storagePath).catch((err) => {
          console.warn(`[${logLabel}] Failed to clean up ${o.storagePath}:`, errorLabel(err));
        })
      )
    );
  };

  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) {
    await removeAll(written);
    throw rejected.reason;
  }

  const byName = new Map<keyof PhotoVariants, SavedObject>();
  entries.forEach(([name], i) => byName.set(name, written[i]));

  const display = byName.get('display') as SavedObject;
  const thumbnail = byName.get('thumbnail') as SavedObject;
  const original = byName.get('original') ?? null;

  let cleaned = false;
  return {
    display,
    thumbnail,
    original,
    totalBytes:
      variants.display.buffer.length +
      variants.thumbnail.buffer.length +
      (variants.original?.buffer.length ?? 0),
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await removeAll(written);
    },
  };
}

export type QuotaWriteOutcome<T> =
  | { ok: true; row: T; hostUserId: string | null }
  | { ok: false; reason: 'event_not_found' }
  | { ok: false; reason: 'quota'; message: string; code: string };

/**
 * Re-check the plan allowance under an event-scoped lock and insert the row
 * inside the same transaction (SEC-D1).
 *
 * `insert` runs on the locked client, after the allowance has held, and is the
 * only thing the caller supplies — that is where the two paths' differing
 * column lists live. Any refusal or thrown error rolls back and calls
 * `cleanup()` before returning or rethrowing, so no file outlives its row.
 */
export async function insertPhotoUnderQuota<T>(args: {
  eventId: string;
  /** Passed through to the fresh context so per-device counts stay accurate. */
  deviceFingerprint?: string;
  storageBytes: number;
  cleanup: () => Promise<void>;
  insert: (client: PoolClient, context: UploadContext) => Promise<T>;
}): Promise<QuotaWriteOutcome<T>> {
  const { eventId, deviceFingerprint, storageBytes, cleanup, insert } = args;

  const lockClient = await pool.connect();
  try {
    await lockClient.query('BEGIN');
    await acquireEventUploadLock(lockClient, eventId);

    const freshContext = await getUploadContext(eventId, deviceFingerprint, lockClient);
    if (!freshContext) {
      await lockClient.query('ROLLBACK');
      await cleanup();
      return { ok: false, reason: 'event_not_found' };
    }

    const finalCheck = checkUploadAllowance(freshContext, storageBytes);
    if (!finalCheck.allowed) {
      await lockClient.query('ROLLBACK');
      await cleanup();
      return {
        ok: false,
        reason: 'quota',
        message: finalCheck.reason || 'Plan limit reached',
        code: finalCheck.code || 'STORAGE_LIMIT_REACHED',
      };
    }

    const row = await insert(lockClient, freshContext);
    await lockClient.query('COMMIT');
    return { ok: true, row, hostUserId: freshContext.hostUserId };
  } catch (err) {
    await lockClient.query('ROLLBACK').catch(() => undefined);
    await cleanup();
    throw err;
  } finally {
    lockClient.release();
  }
}

/**
 * Announce a new photo, applying the two rules that decide who may see it.
 *
 * - **Awaiting moderation:** hosts only. The file is in quarantine, so its real
 *   URLs are unreachable; `broadcastToEventHosts` never reaches the guest room,
 *   which is what makes embedding a host-scoped preview token safe here
 *   (MED-03/SEC-M5).
 * - **Disposable and not yet revealed:** image URLs are stripped from the live
 *   broadcast so guests cannot see the photo before the reveal. Only the guest
 *   path sets this; photographer frames are never disposable-locked.
 *
 * Enforced here rather than left to the read path, because the REST list
 * filters non-hosts to approved/featured and a broadcast that does not apply
 * the same rule puts an unapproved photo straight into every guest's feed.
 */
export function broadcastPhotoAdded(args: {
  eventId: string;
  photoId: string;
  /** The DTO as guests would receive it. */
  photo: object;
  status: string;
  needsQuarantine: boolean;
  hostUserId: string | null;
  hasOriginal: boolean;
  /** Guest path only: the album's reveal time while the photo is locked. */
  lockedUntil?: Date | null;
}): void {
  const { eventId, photoId, photo, status, needsQuarantine, hostUserId, hasOriginal } = args;

  if (status === 'pending') {
    const hostPhoto =
      needsQuarantine && hostUserId
        ? {
            ...photo,
            fullUrl: buildPreviewUrl(photoId, hostUserId, 'display'),
            thumbnailUrl: buildPreviewUrl(photoId, hostUserId, 'thumbnail'),
            originalUrl: hasOriginal ? buildPreviewUrl(photoId, hostUserId, 'original') : null,
          }
        : photo;
    wsManager.broadcastToEventHosts(eventId, 'PHOTO_ADDED', hostPhoto);
    return;
  }

  const revealTime = args.lockedUntil ? args.lockedUntil.getTime() : null;
  const broadcastPhoto =
    revealTime && revealTime > Date.now() ? { ...photo, fullUrl: '', thumbnailUrl: '' } : photo;
  wsManager.broadcastToEvent(eventId, 'PHOTO_ADDED', broadcastPhoto);
}

/** Re-exported so callers do not need a second import for URL building. */
export { toAbsoluteUrl };
