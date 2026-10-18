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
import type { Pool, PoolClient } from 'pg';
import { pool } from '../../lib/db';
import { decodeDataUrl, toAbsoluteUrl } from '../../lib/storage';
import { buildDerivatives } from '../../lib/images';
import { validateBody } from '../../middleware/validate';
import { uploadLimiter, uploadIpLimiter } from '../../middleware/rateLimit';
import { getUploadContext, checkUploadAllowance, meetsTier } from '../../middleware/tierGate';
import { savePhotoVariants, insertPhotoUnderQuota, broadcastPhotoAdded, SavedPhotoFiles } from '../../lib/photoWrite';
import { issueGuestToken } from '../../lib/guestAuth';
import { wsManager } from '../../ws/wsServer';
import { verifyGuestOwnership } from '../../lib/guestIdentity';
import { isImageMagicBytes, isValidUuid } from '../../lib/validation';
import { errorLabel, isUniqueViolation } from '../../lib/errors';
import { DEFAULT_MAX_PHOTOS_PER_GUEST } from '../../../shared/planCaps';
import { CreatePhotoSchema, loadGuestPhotoDto } from './shared';

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

const fail = (
  status: number,
  body: Record<string, unknown>
): { ok: false; status: number; body: Record<string, unknown> } => ({ ok: false, status, body });

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
interface UploaderFields {
  guestId?: string;
  guestToken?: string;
  guestName?: string;
  guestTable?: string;
  deviceFingerprint?: string;
}

/**
 * The uploader, if they already have a guest row: the one their token proves,
 * else the one their device matches. Never creates a row, so it can run
 * before the plan's checks (N-78).
 */
async function findExistingUploader(eventId: string, body: UploaderFields): Promise<ResolvedGuest | null> {
  const { guestId, guestToken, deviceFingerprint } = body;

  if (guestId && isValidUuid(guestId)) {
    // A client-supplied guestId is otherwise trusted with no proof it belongs
    // to this event, or that the caller is that guest — either lets one guest's
    // uploads (and their per-guest quota) be attributed to a guestId harvested
    // from another event or guest (SEC-D3), or from the public feed of this
    // same event (SEC-A2). Treat anything short of a matching token as absent,
    // same as an unknown id.
    // Shared with lib/guestIdentity.ts. This check was written out in both
    // files, and being identical in two places is how the same two defects —
    // an ownership test satisfiable without a token, and a token_version read
    // as 0 — came to exist in both, found weeks apart.
    const owned = await verifyGuestOwnership(eventId, guestId, guestToken);
    if (owned) return { guestId, identityProven: true, tokenVersion: owned.tokenVersion };
  }

  if (deviceFingerprint) {
    const existing = await pool.query(
      'SELECT id, token_version FROM guests WHERE event_id = $1 AND device_fingerprint = $2 LIMIT 1',
      [eventId, deviceFingerprint]
    );
    // Resolved purely via a fingerprint match onto a pre-existing row:
    // attributed correctly, but not proven.
    if (existing.rows[0]) {
      return {
        guestId: existing.rows[0].id,
        identityProven: false,
        tokenVersion: Number(existing.rows[0].token_version) || 0,
      };
    }
  }

  return null;
}

async function resolveGuestForUpload(eventId: string, body: UploaderFields): Promise<ResolvedGuest> {
  const existing = await findExistingUploader(eventId, body);
  if (existing) return existing;

  // The write semantics are this route's own: it may rename a guest and must
  // always produce one, neither of which the comment path is allowed to do.
  const { guestName, guestTable, deviceFingerprint } = body;
  const guestInsert = await pool.query(
    `INSERT INTO guests (event_id, name, avatar_url, table_number, device_fingerprint)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id, device_fingerprint) WHERE device_fingerprint IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name
     RETURNING id, token_version, (xmax = 0) AS inserted`,
    [
      eventId,
      guestName || 'Guest',
      // N-107 — a guest's picture is set only by POST /api/guests/:id/avatar.
      null,
      guestTable || null,
      deviceFingerprint || null,
    ]
  );
  return {
    guestId: guestInsert.rows[0].id,
    tokenVersion: Number(guestInsert.rows[0].token_version) || 0,
    // xmax = 0 means this row was just INSERTed, not matched by the
    // ON CONFLICT UPDATE branch — a genuinely fresh row is inherently this
    // caller's own.
    identityProven: guestInsert.rows[0].inserted,
  };
}

/** Photos this guest already has on the album, against the per-guest ceiling. */
async function checkPerGuestCap(
  eventId: string,
  guestId: string,
  context: UploadContext,
  deviceFingerprint: string | undefined,
  db: Pool | PoolClient = pool
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
        await db.query('SELECT COUNT(*)::int AS count FROM photos WHERE event_id = $1 AND guest_id = $2', [
          eventId,
          guestId,
        ])
      ).rows[0].count;

  if (guestPhotoCount >= maxAllowed) {
    // N-150 — the code is what tells the phone this differs from the rate
    // limiter's 429: no retry will get the photo in, so it must not be queued.
    return fail(429, {
      error: `Photo limit reached (${maxAllowed} per guest).`,
      code: 'GUEST_PHOTO_LIMIT_REACHED',
      max: maxAllowed,
    });
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
async function decodeAndValidateImages(fullUrl: string, originalUrl?: string): Promise<Step<DecodedImages>> {
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
    console.warn('[Photos] Rejected: display image is not decodable:', err instanceof Error ? err.message : err);
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
  questId: string | null;
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
  /** The id the device gave this upload, so a replay finds this row (N-78). */
  clientUploadId: string | null;
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
    eventId,
    guestId,
    questId,
    caption,
    filterApplied,
    deviceFingerprint,
    files,
    urls,
    width,
    height,
    originalBytes,
    initialStatus,
    isLocked,
    needsQuarantine,
    clientUploadId,
  } = args;

  const written = await insertPhotoUnderQuota({
    eventId,
    deviceFingerprint,
    storageBytes: files.totalBytes,
    cleanup: files.cleanup,
    // N-84 — the cap again, under the lock and on its fresh count: checked
    // only before the upload, every photo of a burst passed it at once.
    recheck: async (client, freshContext) => {
      const cap = await checkPerGuestCap(eventId, guestId, freshContext, deviceFingerprint, client);
      return cap.ok ? null : { status: cap.status, body: cap.body };
    },
    insert: async (client) => {
      const photoInsert = await client.query(
        `INSERT INTO photos (
          event_id, guest_id, quest_id, storage_path, full_url, thumbnail_url,
          original_url, original_storage_path, original_bytes,
          caption, status, is_locked, filter_applied, width, height, storage_bytes,
          is_quarantined, client_upload_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
        [
          eventId,
          guestId,
          questId || null,
          files.display.storagePath,
          urls.full,
          urls.thumb,
          urls.original,
          files.original ? files.original.storagePath : null,
          originalBytes,
          caption || null,
          initialStatus,
          isLocked,
          filterApplied || 'original',
          width,
          height,
          files.totalBytes,
          // H4 — recorded here rather than inferred later from a LIKE over the
          // path columns, so the read path can find these rows by index.
          needsQuarantine,
          clientUploadId,
        ]
      );
      return photoInsert.rows[0];
    },
  });

  if (!written.ok) {
    if (written.reason === 'event_not_found') return fail(404, { error: 'Event not found' });
    if (written.reason === 'refused') return fail(written.status, written.body);
    return fail(403, { error: written.message, code: written.code });
  }
  return { ok: true, value: { row: written.row, hostUserId: written.hostUserId } };
}

/**
 * The client's quest id, but only if it names a quest in this event.
 *
 * It arrives from the request body. Taken as given, a photo uploaded to one
 * wedding could name another wedding's quest: the feed would then label it
 * with that quest's title, and the completion would credit this guest on the
 * other wedding's leaderboard. Anything that is not a quest of this event is
 * dropped rather than refused — the photo itself is still a good upload.
 */
async function resolveEventQuestId(eventId: string, questId: string | undefined): Promise<string | null> {
  if (!questId || !isValidUuid(questId)) return null;
  const { rows } = await pool.query('SELECT 1 FROM scavenger_quests WHERE id = $1 AND event_id = $2', [
    questId,
    eventId,
  ]);
  return rows.length > 0 ? questId : null;
}

/**
 * Credit the quest this photo was taken for, and tell the room.
 *
 * This is the only place a quest is completed. The broadcast is what moves
 * every other phone's per-quest count and prompts leaderboards to refetch; it
 * used to come from a separate claim request the phone sent before uploading.
 *
 * Best-effort: a failed quest credit must not fail an upload that succeeded.
 */
async function recordQuestCompletion(
  eventId: string,
  questId: string | null,
  guestId: string,
  photoId: string
): Promise<void> {
  if (!questId) return;
  const recorded = await pool
    .query(
      // N-55 — a retake points the completion at the new photo but keeps the
      // time it was first completed. The leaderboard breaks ties on that time,
      // and restamping it handed the tie, and the prize, to whoever finished
      // after this guest.
      `INSERT INTO guest_quest_completions (quest_id, guest_id, photo_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (quest_id, guest_id) DO UPDATE SET photo_id = $3`,
      [questId, guestId, photoId]
    )
    .then(() => true)
    .catch((err: unknown) => {
      console.warn(
        '[Photos] Quest completion not recorded for photo',
        photoId,
        err instanceof Error ? err.message : err
      );
      return false;
    });
  if (recorded) wsManager.broadcastToEvent(eventId, 'QUEST_COMPLETED', { questId, guestId });
}

/**
 * The photo this guest already stored under this upload id, as the feed lists
 * it, or null.
 *
 * N-78 — a phone replays an upload whose answer it never got. When the first
 * attempt had been stored, the replay used to be stored again: the same photo
 * twice in the album and on the wall, and twice against the allowance.
 */
async function findReplayedPhoto(eventId: string, guestId: string, localId: string) {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM photos WHERE event_id = $1 AND guest_id = $2 AND client_upload_id = $3',
    [eventId, guestId, localId]
  );
  return rows.length > 0 ? loadGuestPhotoDto(rows[0].id) : null;
}

/** The answer to a replay: the stored photo, as the first answer would have carried it. */
function replayAnswer(
  photo: Record<string, unknown>,
  localId: string,
  guest: { guestId: string; identityProven: boolean; tokenVersion: number },
  eventId: string
) {
  return {
    ...photo,
    localId,
    ...(guest.identityProven ? { guestToken: issueGuestToken(guest.guestId, eventId, guest.tokenVersion) } : {}),
  };
}

// 3. POST /api/photos (Scoped to specific wedding event)
photosRouter.post(
  '/',
  uploadIpLimiter,
  uploadLimiter,
  validateBody(CreatePhotoSchema),
  async (req: Request, res: Response) => {
    const {
      eventId,
      guestName,
      guestTable,
      fullUrl,
      originalUrl,
      caption,
      filterApplied,
      questId,
      questTitle,
      localId,
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

      // N-78 — a replay is answered before any check: the photo it carries is
      // already stored and already counted. Refused as over a limit it filled
      // itself, the phone would retry it and finally report it lost.
      if (localId) {
        const uploader = await findExistingUploader(eventId, req.body);
        const stored = uploader ? await findReplayedPhoto(eventId, uploader.guestId, localId) : null;
        if (uploader && stored) return res.status(200).json(replayAnswer(stored, localId, uploader, eventId));
      }

      // N-99 — a limit that refuses an upload carrying an id may have been
      // reached by that same upload: two copies arriving together both pass
      // the check above before either is stored, and the second meets the
      // limit the first has just filled. Look once more before refusing.
      const refuse = async (status: number, body: Record<string, unknown>) => {
        if (localId) {
          const uploader = await findExistingUploader(eventId, req.body);
          const stored = uploader ? await findReplayedPhoto(eventId, uploader.guestId, localId) : null;
          if (uploader && stored) return res.status(200).json(replayAnswer(stored, localId, uploader, eventId));
        }
        return res.status(status).json(body);
      };

      // Cheap pre-check: refuse an event already over its allowance before
      // decoding a payload that may be tens of megabytes.
      const tierCheck = checkUploadAllowance(context);
      if (!tierCheck.allowed) {
        return refuse(403, { error: tierCheck.reason, code: tierCheck.code || 'TIER_LIMIT_REACHED' });
      }

      // H8, the same rule the rest of the app follows: a caller offering
      // neither a token nor a device is asked to identify itself rather than
      // handed a brand-new guest. Without this the per-guest photo cap was
      // one request away from meaningless — every upload that named no
      // device minted a fresh guest, whose count started again at zero.
      if (!req.body.guestToken && !deviceFingerprint) {
        return res.status(401).json({
          error: 'Join the wedding before uploading a photo.',
          code: 'GUEST_IDENTITY_REQUIRED',
        });
      }

      const guest = await resolveGuestForUpload(eventId, req.body);

      const capCheck = await checkPerGuestCap(eventId, guest.guestId, context, deviceFingerprint);
      if (!capCheck.ok) return refuse(capCheck.status, capCheck.body);

      const decoded = await decodeAndValidateImages(fullUrl, originalUrl);
      if (!decoded.ok) return res.status(decoded.status).json(decoded.body);
      const images = decoded.value;

      // Now that the payload is decoded, charge the real footprint against the
      // plan's storage allowance before anything is written.
      const incomingBytes = images.displayData.buffer.length + (images.originalData?.buffer.length || 0);
      if (incomingBytes > 0) {
        const storageCheck = checkUploadAllowance(context, incomingBytes);
        if (!storageCheck.allowed) {
          return refuse(403, {
            error: storageCheck.reason,
            code: storageCheck.code || 'STORAGE_LIMIT_REACHED',
          });
        }
      }

      const initialStatus = context.isModerationEnabled ? 'pending' : 'approved';
      // N-171 — locked only while the reveal is still ahead, by the feed's own
      // rule. Taken from the mode alone, every photo sent after the reveal was
      // quarantined and broadcast as locked, with addresses that load nothing.
      const isLocked =
        context.isDisposableMode && context.revealAt !== null && context.revealAt.getTime() > Date.now();
      // MED-03/SEC-M5 — a photo that isn't immediately public yet (awaiting
      // moderation, or disposable-locked before its reveal) must not be saved
      // to a publicly-reachable path at all. API-level filtering already hides
      // it from everyone but the host, but that does nothing to stop someone
      // who has, guesses, or leaks the raw file URL directly, since
      // express.static has no concept of "pending."
      const needsQuarantine = initialStatus === 'pending' || isLocked;

      // N-123 — no quest completes below the tier that sells quests.
      const scopedQuestId = meetsTier(context.tier, 'celebration_pass')
        ? await resolveEventQuestId(eventId, questId)
        : null;

      const files = await persistPhotoFiles(eventId, images, needsQuarantine);
      const urls = {
        full: toAbsoluteUrl(files.display.storagePath),
        thumb: toAbsoluteUrl(files.thumbnail.storagePath),
        original: files.original ? toAbsoluteUrl(files.original.storagePath) : null,
      };

      let inserted: Awaited<ReturnType<typeof insertPhotoAtomically>>;
      try {
        inserted = await insertPhotoAtomically({
          eventId,
          guestId: guest.guestId,
          questId: scopedQuestId,
          caption,
          filterApplied,
          deviceFingerprint,
          files,
          urls,
          width: images.derivatives.width || null,
          height: images.derivatives.height || null,
          originalBytes: images.originalData ? images.originalData.buffer.length : null,
          initialStatus,
          isLocked,
          needsQuarantine,
          clientUploadId: localId || null,
        });
      } catch (err) {
        // Two copies of one upload arrived together and the other was stored
        // first. This copy's files were removed when its insert failed.
        if (localId && isUniqueViolation(err, 'idx_photos_client_upload')) {
          const stored = await findReplayedPhoto(eventId, guest.guestId, localId);
          if (stored) return res.status(200).json(replayAnswer(stored, localId, guest, eventId));
        }
        throw err;
      }
      if (!inserted.ok) return refuse(inserted.status, inserted.body);
      const { row: created, hostUserId } = inserted.value;

      await recordQuestCompletion(eventId, scopedQuestId, guest.guestId, created.id);

      // N-107 — the picture on record, never the one this request carried:
      // this object is the PHOTO_ADDED broadcast every guest in the room
      // receives, and it used to echo the client's value to all of them.
      const avatarRow = await pool.query<{ avatar_url: string | null }>(
        'SELECT avatar_url FROM guests WHERE id = $1',
        [guest.guestId]
      );
      const guestAvatar = avatarRow.rows[0]?.avatar_url ?? null;

      const newPhoto = {
        id: created.id,
        eventId: created.event_id,
        guestId: guest.guestId,
        guestName: guestName || 'Guest',
        guestAvatar,
        guestTable,
        questId: scopedQuestId ?? undefined,
        questTitle: scopedQuestId ? questTitle : undefined,
        storagePath: files.display.storagePath,
        thumbnailUrl: urls.thumb,
        fullUrl: urls.full,
        originalUrl: urls.original,
        caption,
        status: initialStatus,
        isLocked,
        filterApplied: filterApplied || 'original',
        source: 'guest',
        priority: 0,
        likesCount: 0,
        commentsCount: 0,
        likedByGuestIds: [],
        reactions: [],
        comments: [],
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
        ...(guest.identityProven ? { guestToken: issueGuestToken(guest.guestId, eventId, guest.tokenVersion) } : {}),
      });
    } catch (err) {
      console.error('[Photos] POST error:', errorLabel(err));
      res.status(500).json({ error: 'Failed to save photo. Please try again.' });
    }
  }
);
