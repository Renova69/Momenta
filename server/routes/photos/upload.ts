/**
 * POST /api/photos — a guest contributing a photo to an album.
 *
 * Split out of the former single-file `photos.ts`, where this one handler ran
 * to 372 lines: far past the 50-line limit in the project's coding standards,
 * and long enough that the ordering constraints inside it — quarantine decided
 * before anything is written, files cleaned up if the insert fails, the quota
 * re-checked under a lock — were only discoverable by reading all of it.
 *
 * It is now an orchestration over named steps, each stating the rule it
 * enforces. **Their order is load-bearing** and the handler at the bottom is
 * the only place that order is expressed.
 *
 * The steps that this path and the photographer ingest path have to get
 * identically right — orphan cleanup, the locked quota re-check, and what a
 * quarantined photo may be broadcast as — live in `server/lib/photoWrite.ts`
 * and are called from both. What stays here is what genuinely differs: guest
 * identity, the filenames, and the column list.
 */

import { Router, Request, Response } from 'express';
import { pool } from '../../lib/db';
import { decodeDataUrl, toAbsoluteUrl } from '../../lib/storage';
import { buildDerivatives } from '../../lib/images';
import { validateBody } from '../../middleware/validate';
import { uploadLimiter, uploadIpLimiter } from '../../middleware/rateLimit';
import { getUploadContext, checkUploadAllowance } from '../../middleware/tierGate';
import {
  savePhotoVariants,
  insertPhotoUnderQuota,
  broadcastPhotoAdded,
  SavedPhotoFiles,
} from '../../lib/photoWrite';
import { issueGuestToken, verifyGuestToken } from '../../lib/guestAuth';
import { isImageMagicBytes, isValidUuid } from '../../lib/validation';
import { errorLabel } from '../../lib/errors';
import { DEFAULT_MAX_PHOTOS_PER_GUEST } from '../../../shared/planCaps';
import { CreatePhotoSchema } from './shared';

const photosRouter = Router();
export { photosRouter as uploadRouter };

/**
 * A step either produces its value or names the HTTP response that ends the
 * request. This matches the convention already used by
 * `server/lib/ingestPipeline.ts` rather than throwing for control flow, so a
 * refusal (a full album, an undecodable file) stays visibly distinct from a
 * failure, which still throws and becomes a 500.
 */
type Step<T> = { ok: true; value: T } | { ok: false; status: number; body: Record<string, unknown> };

const fail = (status: number, body: Record<string, unknown>): { ok: false; status: number; body: Record<string, unknown> } =>
  ({ ok: false, status, body });

/** The event's settings, plan allowance and current usage, in one round trip. */
type UploadContext = NonNullable<Awaited<ReturnType<typeof getUploadContext>>>;

interface ResolvedGuest {
  guestId: string;
  /**
   * SEC-03 — whether the caller actually demonstrated ownership of `guestId`
   * (a verified token, or a row created fresh in this very request, which is
   * inherently theirs) rather than merely supplying a deviceFingerprint that
   * happens to match someone else's existing row.
   */
  identityProven: boolean;
  /** M10 — so a token minted at the end carries the row's current version. */
  tokenVersion: number;
}

/**
 * Resolve who is uploading.
 *
 * The device fingerprint — not the client-supplied guestId — anchors identity,
 * otherwise omitting guestId mints a fresh guest on every request and resets
 * the per-guest photo cap to zero.
 *
 * Fingerprints are client-generated and sent as plain, non-secret request
 * fields. Matching one is enough to keep counting this upload against the right
 * guest's quota (the whole point of the fallback), but must not be enough to
 * mint a durable guestToken for that identity: a caller who merely knows a
 * leaked fingerprint should not walk away with a signed credential they could
 * use to like, comment and upload as that guest indefinitely afterwards. That
 * is what `identityProven` carries.
 */
async function resolveGuestForUpload(
  eventId: string,
  body: {
    guestId?: string;
    guestToken?: string;
    guestName?: string;
    guestAvatar?: string;
    guestTable?: string;
    deviceFingerprint?: string;
  }
): Promise<ResolvedGuest> {
  const { guestId, guestToken, guestName, guestAvatar, guestTable, deviceFingerprint } = body;
  let currentGuestId = guestId;
  let identityProven = false;
  let tokenVersion = 0;

  if (currentGuestId && isValidUuid(currentGuestId) && !currentGuestId.startsWith('guest-')) {
    // A client-supplied guestId is otherwise trusted with no proof it belongs
    // to this event, or that the caller is that guest — either lets one guest's
    // uploads (and their per-guest quota) be attributed to a guestId harvested
    // from another event or guest (SEC-D3), or from the public feed of this
    // same event (SEC-A2). Treat anything short of a matching token as absent,
    // same as an unknown id.
    const owns = await pool.query(
      'SELECT id, token_version FROM guests WHERE id = $1 AND event_id = $2',
      [currentGuestId, eventId]
    );
    if (
      owns.rows.length === 0 ||
      !verifyGuestToken(guestToken, currentGuestId, eventId, owns.rows[0].token_version)
    ) {
      currentGuestId = undefined;
    } else {
      identityProven = true;
      tokenVersion = Number(owns.rows[0].token_version) || 0;
    }
  }

  if (!currentGuestId || currentGuestId.startsWith('guest-') || !isValidUuid(currentGuestId)) {
    if (deviceFingerprint) {
      const existing = await pool.query(
        'SELECT id, token_version FROM guests WHERE event_id = $1 AND device_fingerprint = $2 LIMIT 1',
        [eventId, deviceFingerprint]
      );
      currentGuestId = existing.rows[0]?.id;
      tokenVersion = Number(existing.rows[0]?.token_version) || 0;
    }

    if (!currentGuestId) {
      const guestInsert = await pool.query(
        `INSERT INTO guests (event_id, name, avatar_url, table_number, device_fingerprint)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_id, device_fingerprint) WHERE device_fingerprint IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name
         RETURNING id, token_version, (xmax = 0) AS inserted`,
        [eventId, guestName || 'Guest', guestAvatar || null, guestTable || null, deviceFingerprint || null]
      );
      currentGuestId = guestInsert.rows[0].id;
      tokenVersion = Number(guestInsert.rows[0].token_version) || 0;
      // xmax = 0 means this row was just INSERTed, not matched by the
      // ON CONFLICT UPDATE branch — a genuinely fresh row is inherently this
      // caller's own.
      identityProven = guestInsert.rows[0].inserted;
    }
    // else: resolved purely via fingerprint match onto a pre-existing row —
    // identityProven stays false.
  }

  return { guestId: currentGuestId as string, identityProven, tokenVersion };
}

/** Photos this guest already has on the album, against the per-guest ceiling. */
async function checkPerGuestCap(
  eventId: string,
  guestId: string,
  context: UploadContext,
  deviceFingerprint: string | undefined
): Promise<Step<null>> {
  // `??`, not `||`: the column is nullable and only null means "host set no
  // limit". `||` also swallowed 0, which is the one value a host could pick
  // that means the opposite — accept nothing — and turned it into 50.
  const maxAllowed = context.maxPhotosPerGuest ?? DEFAULT_MAX_PHOTOS_PER_GUEST;
  // Counted per device fingerprint when one is present, so extra guest rows on
  // the same device share a single budget.
  const guestPhotoCount = deviceFingerprint
    ? context.devicePhotoCount
    : (
        await pool.query(
          'SELECT COUNT(*)::int AS count FROM photos WHERE event_id = $1 AND guest_id = $2',
          [eventId, guestId]
        )
      ).rows[0].count;

  if (guestPhotoCount >= maxAllowed) {
    return fail(429, { error: `Photo limit reached (${maxAllowed} per guest).` });
  }
  return { ok: true, value: null };
}

interface DecodedImages {
  displayData: NonNullable<ReturnType<typeof decodeDataUrl>>;
  originalData: ReturnType<typeof decodeDataUrl>;
  derivatives: Awaited<ReturnType<typeof buildDerivatives>>;
}

/**
 * Decode the payloads once and prove they are really images.
 *
 * `fullUrl` is the filtered display copy the guest just previewed;
 * `originalUrl` is the untouched capture kept for the high-resolution export.
 *
 * Magic bytes only prove the header. A file can match JPEG/PNG/GIF/WebP's first
 * few bytes and still be truncated, corrupt, or not really decodable — so the
 * real derivatives are built here, before anything is written, and a file that
 * fails is rejected outright instead of a broken photo silently reaching the
 * feed (SEC-M4).
 */
async function decodeAndValidateImages(
  fullUrl: string,
  originalUrl?: string
): Promise<Step<DecodedImages>> {
  const displayData = decodeDataUrl(fullUrl);
  const originalData = decodeDataUrl(originalUrl);

  // Redundant with the schema-level check, but this is the line that actually
  // gates whether the storage path falls back to the raw client string — keep
  // it unconditional, not just when the string happens to look like a data:
  // URL (SEC-A1).
  if (!displayData) return fail(400, { error: 'Invalid image data.' });
  // Image-only check — this endpoint never accepts audio (SEC-M4).
  if (!isImageMagicBytes(displayData.buffer)) return fail(400, { error: 'Invalid image data.' });
  if (originalUrl && originalUrl.startsWith('data:') && !originalData) {
    return fail(400, { error: 'Invalid original image data.' });
  }
  if (originalData && !isImageMagicBytes(originalData.buffer)) {
    return fail(400, { error: 'Invalid original image data.' });
  }

  let derivatives;
  try {
    derivatives = await buildDerivatives(displayData.buffer);
  } catch (err) {
    console.warn(
      '[Photos] Rejected: display image is not decodable:',
      err instanceof Error ? err.message : err
    );
    return fail(400, { error: 'Invalid image data.' });
  }

  return { ok: true, value: { displayData, originalData, derivatives } };
}

/**
 * Write the display copy, its thumbnail and any original to storage.
 *
 * Filenames keep the `wedding-photo-<ts>-<rand>` convention this path has
 * always used — `savePhotoVariants` does the writing, tracking and cleanup, but
 * the caller still names the files, so nothing about what lands in the bucket
 * changes.
 */
async function persistPhotoFiles(
  eventId: string,
  images: DecodedImages,
  needsQuarantine: boolean
): Promise<SavedPhotoFiles> {
  const { displayData, originalData, derivatives } = images;
  const stamp = () => `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  return savePhotoVariants(
    eventId,
    {
      display: {
        buffer: displayData.buffer,
        filename: `wedding-photo-${stamp()}${displayData.ext}`,
        mimetype: displayData.mimetype,
      },
      // Derived from the display copy rather than reusing it: a feed card does
      // not need a 1600px image, and the filter is already baked in.
      // Decodability was proven above, before anything was written.
      thumbnail: {
        buffer: derivatives.thumbnail,
        filename: `wedding-thumb-${stamp()}.jpg`,
        mimetype: 'image/jpeg',
      },
      ...(originalData
        ? {
            original: {
              buffer: originalData.buffer,
              filename: `wedding-original-${stamp()}${originalData.ext}`,
              mimetype: originalData.mimetype,
            },
          }
        : {}),
    },
    needsQuarantine,
    'Photos'
  );
}

interface InsertPhotoArgs {
  eventId: string;
  guestId: string;
  questId?: string;
  caption?: string;
  filterApplied?: string;
  deviceFingerprint?: string;
  files: SavedPhotoFiles;
  urls: { full: string; thumb: string; original: string | null };
  /** From the decoded display copy; the saved-files result does not carry them. */
  width: number | null;
  height: number | null;
  originalBytes: number | null;
  initialStatus: string;
  isLocked: boolean;
  needsQuarantine: boolean;
}

/**
 * Insert the photo row under the shared locked-quota protocol (SEC-D1).
 *
 * `insertPhotoUnderQuota` owns the lock, the re-check and the cleanup of the
 * files already written; this supplies only the column list, which is the part
 * that differs from the photographer path.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertPhotoAtomically(args: InsertPhotoArgs): Promise<Step<{ row: any; hostUserId: string | null }>> {
  const {
    eventId, guestId, questId, caption, filterApplied, deviceFingerprint,
    files, urls, width, height, originalBytes, initialStatus, isLocked, needsQuarantine,
  } = args;

  const written = await insertPhotoUnderQuota({
    eventId,
    deviceFingerprint,
    storageBytes: files.totalBytes,
    cleanup: files.cleanup,
    insert: async (client) => {
      const photoInsert = await client.query(
        `INSERT INTO photos (
          event_id, guest_id, quest_id, storage_path, full_url, thumbnail_url,
          original_url, original_storage_path, original_bytes,
          caption, status, is_locked, filter_applied, width, height, storage_bytes,
          is_quarantined
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
        [eventId, guestId, questId || null, files.display.storagePath, urls.full,
         urls.thumb, urls.original, files.original ? files.original.storagePath : null,
         originalBytes,
         caption || null, initialStatus, isLocked, filterApplied || 'original',
         width, height, files.totalBytes,
         // H4 — recorded here rather than inferred later from a LIKE over the
         // path columns, so the read path can find these rows by index.
         needsQuarantine]
      );
      return photoInsert.rows[0];
    },
  });

  if (!written.ok) {
    return written.reason === 'event_not_found'
      ? fail(404, { error: 'Event not found' })
      : fail(403, { error: written.message, code: written.code });
  }
  return { ok: true, value: { row: written.row, hostUserId: written.hostUserId } };
}

/** Best-effort: a failed quest credit must not fail an upload that succeeded. */
async function recordQuestCompletion(
  questId: string | undefined,
  guestId: string,
  photoId: string
): Promise<void> {
  if (!questId || !isValidUuid(questId)) return;
  await pool
    .query(
      `INSERT INTO guest_quest_completions (quest_id, guest_id, photo_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (quest_id, guest_id) DO UPDATE SET photo_id = $3, completed_at = NOW()`,
      [questId, guestId, photoId]
    )
    .catch((err: unknown) => {
      console.warn(
        '[Photos] Quest completion not recorded for photo',
        photoId,
        err instanceof Error ? err.message : err
      );
    });
}

// 3. POST /api/photos (Scoped to specific wedding event)
photosRouter.post(
  '/',
  uploadIpLimiter,
  uploadLimiter,
  validateBody(CreatePhotoSchema),
  async (req: Request, res: Response) => {
    const {
      eventId, guestName, guestAvatar, guestTable,
      fullUrl, originalUrl, caption, filterApplied, questId, questTitle, localId,
      deviceFingerprint,
    } = req.body;

    try {
      if (!eventId || !isValidUuid(eventId)) {
        return res.status(400).json({ error: 'A valid eventId is required' });
      }

      // One round trip gathers the event settings, the plan's allowance,
      // current usage and this device's photo count. Splitting these across
      // separate queries exhausted the connection pool during an upload burst.
      const context = await getUploadContext(eventId, deviceFingerprint);
      if (!context) return res.status(404).json({ error: 'Event not found' });

      // Cheap pre-check: refuse an event already over its allowance before
      // decoding a payload that may be tens of megabytes.
      const tierCheck = checkUploadAllowance(context);
      if (!tierCheck.allowed) {
        return res
          .status(403)
          .json({ error: tierCheck.reason, code: tierCheck.code || 'TIER_LIMIT_REACHED' });
      }

      const guest = await resolveGuestForUpload(eventId, req.body);

      const capCheck = await checkPerGuestCap(eventId, guest.guestId, context, deviceFingerprint);
      if (!capCheck.ok) return res.status(capCheck.status).json(capCheck.body);

      const decoded = await decodeAndValidateImages(fullUrl, originalUrl);
      if (!decoded.ok) return res.status(decoded.status).json(decoded.body);
      const images = decoded.value;

      // Now that the payload is decoded, charge the real footprint against the
      // plan's storage allowance before anything is written.
      const incomingBytes =
        images.displayData.buffer.length + (images.originalData?.buffer.length || 0);
      if (incomingBytes > 0) {
        const storageCheck = checkUploadAllowance(context, incomingBytes);
        if (!storageCheck.allowed) {
          return res.status(403).json({
            error: storageCheck.reason,
            code: storageCheck.code || 'STORAGE_LIMIT_REACHED',
          });
        }
      }

      const initialStatus = context.isModerationEnabled ? 'pending' : 'approved';
      const isLocked = context.isDisposableMode;
      // MED-03/SEC-M5 — a photo that isn't immediately public yet (awaiting
      // moderation, or disposable-locked before its reveal) must not be saved
      // to a publicly-reachable path at all. API-level filtering already hides
      // it from everyone but the host, but that does nothing to stop someone
      // who has, guesses, or leaks the raw file URL directly, since
      // express.static has no concept of "pending."
      const needsQuarantine = initialStatus === 'pending' || isLocked;

      const files = await persistPhotoFiles(eventId, images, needsQuarantine);
      const urls = {
        full: toAbsoluteUrl(files.display.storagePath),
        thumb: toAbsoluteUrl(files.thumbnail.storagePath),
        original: files.original ? toAbsoluteUrl(files.original.storagePath) : null,
      };

      const inserted = await insertPhotoAtomically({
        eventId, guestId: guest.guestId, questId, caption, filterApplied, deviceFingerprint,
        files, urls,
        width: images.derivatives.width || null,
        height: images.derivatives.height || null,
        originalBytes: images.originalData ? images.originalData.buffer.length : null,
        initialStatus, isLocked, needsQuarantine,
      });
      if (!inserted.ok) return res.status(inserted.status).json(inserted.body);
      const { row: created, hostUserId } = inserted.value;

      await recordQuestCompletion(questId, guest.guestId, created.id);

      const newPhoto = {
        id: created.id,
        eventId: created.event_id,
        guestId: guest.guestId,
        guestName: guestName || 'Guest',
        guestAvatar, guestTable, questId, questTitle,
        storagePath: files.display.storagePath,
        thumbnailUrl: urls.thumb,
        fullUrl: urls.full,
        originalUrl: urls.original,
        caption, status: initialStatus, isLocked,
        filterApplied: filterApplied || 'original',
        source: 'guest', priority: 0,
        likesCount: 0, commentsCount: 0, likedByGuestIds: [], reactions: [], comments: [],
        createdAt: created.created_at,
        ...(localId ? { localId } : {}),
      };

      broadcastPhotoAdded({
        eventId,
        photoId: created.id,
        photo: newPhoto,
        status: initialStatus,
        needsQuarantine,
        hostUserId,
        hasOriginal: Boolean(urls.original),
        // Disposable albums withhold the image from guests until the reveal.
        lockedUntil: isLocked ? context.revealAt : null,
      });

      // The token is added only to the direct HTTP response, never to the
      // broadcast above — every other guest in the room receives that message,
      // and a token in it would let any of them impersonate the uploader
      // (SEC-A2). The client persists this per event to prove the same guest
      // identity on likes/comments/future uploads. Only issued when identity
      // was actually proven this request (SEC-03) — a fingerprint-only match
      // onto someone else's pre-existing row still gets attributed correctly
      // for quota purposes, but does not walk away with a usable credential.
      res.status(201).json({
        ...newPhoto,
        ...(guest.identityProven
          ? { guestToken: issueGuestToken(guest.guestId, eventId, guest.tokenVersion) }
          : {}),
      });
    } catch (err) {
      console.error('[Photos] POST error:', errorLabel(err));
      res.status(500).json({ error: 'Failed to save photo. Please try again.' });
    }
  }
);
