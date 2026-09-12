import { Request, Response, NextFunction } from 'express';
import { Pool, PoolClient } from 'pg';
import { pool } from '../lib/db';
import { limitsFor, formatBytes } from '../lib/planLimits';
import { isValidUuid } from '../lib/validation';
/** Tier order lives in `shared/planCaps.ts` so client and server cannot disagree. */
import { TIER_WEIGHTS } from '../../shared/planCaps';

export type BackendPlanTier = 'free' | 'celebration_pass' | 'deluxe_keepsake' | 'pro_planner';


/**
 * Re-exported, not restated. The number lives in `shared/planCaps.ts` so the
 * client's approaching-the-limit warning and this module's enforcement read the
 * same constant; `PLAN_LIMITS.free.maxPhotos` is derived from it too.
 */
export { FREE_TIER_MAX_PHOTOS } from '../../shared/planCaps';

/** True when `current` is at least as high as `required`. */
export function meetsTier(current: BackendPlanTier, required: BackendPlanTier): boolean {
  return (TIER_WEIGHTS[current] ?? 0) >= (TIER_WEIGHTS[required] ?? 0);
}

/**
 * Resolves the effective plan tier for an event from its host's ACTIVE subscription.
 *
 * The event's denormalized `plan_tier` column is intentionally NOT trusted for
 * entitlement decisions — the `subscriptions` table is the single source of truth.
 * Events without a linked host or without an active subscription fall back to `free`.
 */
export async function getEffectiveTierForEvent(eventId: string): Promise<BackendPlanTier> {
  const result = await pool.query(
    `SELECT s.tier AS tier
     FROM events e
     JOIN subscriptions s ON s.user_id = e.host_user_id
     WHERE e.id = $1 AND s.status = 'active'
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [eventId]
  );

  const tier = result.rows[0]?.tier as BackendPlanTier | undefined;
  return tier && TIER_WEIGHTS[tier] !== undefined ? tier : 'free';
}

/**
 * The effective tier for a *host*, which is what the subscriptions table
 * actually records.
 *
 * M5 — GET /api/events resolved this once per event, sequentially, inside a
 * `for` loop. Every row in that response belongs to the one authenticated
 * host, so all those queries were asking an identical question and getting an
 * identical answer. getEffectiveTierForEvent remains the right call wherever
 * only an event id is in hand; this is for the case where the host is already
 * known.
 */
export async function getEffectiveTierForUser(userId: string): Promise<BackendPlanTier> {
  const result = await pool.query(
    `SELECT s.tier AS tier
       FROM subscriptions s
      WHERE s.user_id = $1 AND s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 1`,
    [userId]
  );

  const tier = result.rows[0]?.tier as BackendPlanTier | undefined;
  return tier && TIER_WEIGHTS[tier] !== undefined ? tier : 'free';
}

/**
 * Middleware ensuring the event associated with the request meets a minimum tier level.
 */
export function requireEventTier(minTier: BackendPlanTier) {
  const minWeight = TIER_WEIGHTS[minTier] ?? 0;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const eventId = req.params.id || req.params.eventId || req.body?.eventId || req.query?.eventId;

    if (!eventId || typeof eventId !== 'string') {
      res.status(400).json({ error: 'eventId parameter is required for tier validation' });
      return;
    }

    // A malformed id reaches Postgres as an invalid uuid literal, which throws
    // 22P02 and surfaced from the catch below as a 500 — the caller's bad input
    // reported as a server fault. Not a bypass (the gate still fails closed),
    // but the wrong answer, and it buried real 500s in this route's logs.
    if (!isValidUuid(eventId)) {
      res.status(400).json({ error: 'eventId must be a valid UUID' });
      return;
    }

    try {
      const eventRes = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
      if (eventRes.rows.length === 0) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }

      const currentTier = await getEffectiveTierForEvent(eventId);
      const currentWeight = TIER_WEIGHTS[currentTier] ?? 0;

      if (currentWeight < minWeight) {
        res.status(403).json({
          error: `Тази функционалност изисква план "${minTier}" или по-висок.`,
          requiredTier: minTier,
          currentTier,
          code: 'TIER_REQUIRED',
        });
        return;
      }

      next();
    } catch (err) {
      console.error('[requireEventTier error]:', err);
      res.status(500).json({ error: 'Internal server error validating tier' });
    }
  };
}

export interface UploadContext {
  eventId: string;
  hostUserId: string | null;
  tier: BackendPlanTier;
  usedBytes: number;
  limitBytes: number;
  pooled: boolean;
  photoCount: number;
  maxPhotos: number | null;
  /** Photos already uploaded from this device, when a fingerprint was supplied. */
  devicePhotoCount: number;
  isModerationEnabled: boolean;
  isDisposableMode: boolean;
  revealAt: Date | null;
  maxPhotosPerGuest: number | null;
}

/**
 * Everything the upload handler needs, in one round trip.
 *
 * The handler used to make about ten separate queries per photo. During a burst
 * — which is exactly when a wedding uploads — that exhausted the connection pool
 * and guests got 500s instead of photos. Gathering it once keeps the pool free
 * for the work that actually needs it.
 */
export async function getUploadContext(
  eventId: string,
  deviceFingerprint?: string,
  db: Pool | PoolClient = pool
): Promise<UploadContext | null> {
  const { rows } = await db.query(
    `SELECT e.id,
            e.host_user_id,
            e.storage_bytes,
            e.is_moderation_enabled,
            e.is_disposable_mode,
            e.reveal_at,
            e.max_photos_per_guest,
            COALESCE(s.tier, 'free') AS tier,
            (SELECT COUNT(*)::int FROM photos p WHERE p.event_id = e.id) AS photo_count,
            (SELECT COALESCE(SUM(e2.storage_bytes), 0)::bigint
               FROM events e2
              WHERE e.host_user_id IS NOT NULL AND e2.host_user_id = e.host_user_id) AS pooled_bytes,
            (SELECT COUNT(*)::int
               FROM photos p
               JOIN guests g ON g.id = p.guest_id
              WHERE p.event_id = e.id
                AND $2::text IS NOT NULL
                AND g.device_fingerprint = $2) AS device_photo_count
       FROM events e
       LEFT JOIN subscriptions s
         ON s.user_id = e.host_user_id AND s.status = 'active'
      WHERE e.id = $1
      LIMIT 1`,
    [eventId, deviceFingerprint ?? null]
  );

  if (rows.length === 0) return null;
  const row = rows[0];

  const tier = (TIER_WEIGHTS[row.tier as BackendPlanTier] !== undefined
    ? row.tier
    : 'free') as BackendPlanTier;
  const limits = limitsFor(tier);

  return {
    eventId: row.id,
    hostUserId: row.host_user_id,
    tier,
    usedBytes: Number(limits.pooled ? row.pooled_bytes : row.storage_bytes) || 0,
    limitBytes: limits.storageBytes,
    pooled: limits.pooled,
    photoCount: row.photo_count ?? 0,
    maxPhotos: limits.maxPhotos,
    devicePhotoCount: row.device_photo_count ?? 0,
    isModerationEnabled: !!row.is_moderation_enabled,
    isDisposableMode: !!row.is_disposable_mode,
    revealAt: row.reveal_at ? new Date(row.reveal_at) : null,
    maxPhotosPerGuest: row.max_photos_per_guest ?? null,
  };
}

/** Apply the plan's limits to an already-loaded context. */
export function checkUploadAllowance(
  context: UploadContext,
  incomingBytes = 0
): UploadAllowance {
  if (context.maxPhotos !== null && context.photoCount >= context.maxPhotos) {
    return {
      allowed: false,
      code: 'TIER_LIMIT_REACHED',
      reason: `Достигнат е лимитът от ${context.maxPhotos} снимки за безплатния план. Надградете пакета за неограничени снимки.`,
    };
  }

  if (context.usedBytes + incomingBytes > context.limitBytes) {
    const scope = context.pooled ? 'за вашия профил' : 'за това събитие';
    return {
      allowed: false,
      code: 'STORAGE_LIMIT_REACHED',
      reason:
        `Достигнат е лимитът от ${formatBytes(context.limitBytes)} място ${scope} ` +
        `(използвани ${formatBytes(context.usedBytes)}). Надградете пакета за повече място.`,
    };
  }

  return { allowed: true };
}

/**
 * Serializes concurrent uploads for one event so a re-check immediately
 * before the INSERT sees an up-to-date count/byte total (SEC-D1).
 *
 * `getUploadContext` reads via a plain SELECT with no lock, and the photo
 * row it is charged against is inserted well after that read returns — a
 * burst of concurrent requests can all read the same stale usage and all
 * pass, overshooting the plan's cap by however many landed in that window.
 * A transaction-scoped advisory lock, keyed by eventId, means only one
 * upload for a given event is inside its final check-and-insert at a time;
 * every other concurrent request for the *same* event blocks here until
 * that transaction commits or rolls back, then sees the real total. Uploads
 * for *different* events never contend with each other.
 *
 * Call this only right before the final re-check-and-insert, on a client
 * already inside `BEGIN` — the lock is released automatically at
 * COMMIT/ROLLBACK, not by any explicit unlock call.
 */
export async function acquireEventUploadLock(client: PoolClient, eventId: string): Promise<void> {
  // DB-11: hashtext() returns a 32-bit int, so two unrelated event ids had a
  // real (if small) chance of hashing to the same lock key and needlessly
  // serializing their uploads against each other. hashtextextended(_, 0)
  // returns a real 64-bit hash, matching pg_advisory_xact_lock's own bigint
  // key space instead of narrowing into a fraction of it first.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [eventId]);
}

/**
 * Same pattern as acquireEventUploadLock, keyed on the host instead of an
 * event (DB-06) — the per-user active-event count check in POST /api/events
 * ran as a plain SELECT with no lock, so two concurrent creation requests
 * could both read the same stale count and both pass a 1-event plan's limit.
 * A distinct key prefix keeps this from ever colliding with an upload lock
 * that happens to hash the same raw id.
 */
export async function acquireUserEventCreationLock(client: PoolClient, userId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`user_events_${userId}`]);
}

export interface StorageUsage {
  tier: BackendPlanTier;
  usedBytes: number;
  limitBytes: number;
  /** True when the allowance is shared across all of the host's events. */
  pooled: boolean;
  photoCount: number;
  maxPhotos: number | null;
}

/**
 * Current storage position for an event.
 *
 * Reads the running `events.storage_bytes` total rather than summing rows on
 * every upload — the column is maintained by trigger, the same way likes and
 * comment counts are. Pro Planner pools its allowance across the host's events,
 * so that case sums the host's albums instead.
 */
export async function getStorageUsage(eventId: string): Promise<StorageUsage | null> {
  const eventRes = await pool.query(
    'SELECT id, host_user_id, storage_bytes FROM events WHERE id = $1',
    [eventId]
  );
  if (eventRes.rows.length === 0) return null;

  const event = eventRes.rows[0];
  const tier = await getEffectiveTierForEvent(eventId);
  const limits = limitsFor(tier);

  let usedBytes = Number(event.storage_bytes) || 0;
  if (limits.pooled && event.host_user_id) {
    const pooledRes = await pool.query(
      'SELECT COALESCE(SUM(storage_bytes), 0)::bigint AS total FROM events WHERE host_user_id = $1',
      [event.host_user_id]
    );
    usedBytes = Number(pooledRes.rows[0]?.total) || 0;
  }

  const countRes = await pool.query(
    'SELECT COUNT(*)::int AS count FROM photos WHERE event_id = $1',
    [eventId]
  );

  return {
    tier,
    usedBytes,
    limitBytes: limits.storageBytes,
    pooled: limits.pooled,
    photoCount: countRes.rows[0]?.count ?? 0,
    maxPhotos: limits.maxPhotos,
  };
}

export interface UploadAllowance {
  allowed: boolean;
  reason?: string;
  code?: 'TIER_LIMIT_REACHED' | 'STORAGE_LIMIT_REACHED';
}

/**
 * Validates whether a new upload fits the event's plan.
 *
 * Checks both the photo count (the free tier's 50-photo cap) and the storage
 * allowance the plan actually sells. `incomingBytes` lets the caller test the
 * upload it is about to write, so an oversized file is refused before it is
 * stored rather than after.
 *
 * Fails CLOSED on internal errors, so a limit cannot be bypassed by inducing a
 * database failure.
 */
export async function checkPhotoUploadTierLimit(
  eventId: string,
  incomingBytes = 0
): Promise<UploadAllowance> {
  try {
    const context = await getUploadContext(eventId);
    if (!context) return { allowed: false, reason: 'Event not found' };

    return checkUploadAllowance(context, incomingBytes);
  } catch (err) {
    console.error('[checkPhotoUploadTierLimit error]:', err);
    return { allowed: false, reason: 'Не можахме да потвърдим лимитите на плана. Моля, опитайте отново.' };
  }
}
