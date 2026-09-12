import { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { storageAdapter, toStoragePath } from './storage';
import { limitsFor } from './planLimits';
import { errorLabel } from './errors';
import { BackendPlanTier } from '../middleware/tierGate';

/**
 * Album retention.
 *
 * Each plan sells an archive window (7 days, 3 months, 12 months, or ongoing).
 * Without this, storage accrues forever against a one-time fee — the single
 * largest gap between the pricing model and what the system actually does.
 *
 * Deletion is destructive and irreversible: these are someone's wedding photos.
 * The sweep therefore reports by default and only deletes when
 * RETENTION_ENFORCED=true is set explicitly, and never before the grace period
 * that follows `expires_at`.
 */

/** Days after `expires_at` before an album is actually eligible for deletion. */
export const GRACE_PERIOD_DAYS = 30;

/**
 * Days a host must have been warned before their album can be deleted (D1).
 *
 * Destroying irreplaceable photographs without telling anyone first is not a
 * defensible default, and a retention clause in the terms is not notice. So
 * notice is a precondition in the code rather than a line in a policy: the
 * sweep will not delete an album whose `retention_notified_at` is null or
 * younger than this.
 *
 * **The mailer now exists, and this is live.** When this guard was written
 * there was no way to send a notice, so nothing ever set the column and
 * RETENTION_ENFORCED=true deleted nothing — a safe rehearsal. That is no
 * longer true: `sendRetentionNotices` stamps `retention_notified_at` after a
 * confirmed send (`server/lib/retentionNotice.ts:326`), so with SMTP_HOST
 * configured and notices sent more than RETENTION_NOTICE_DAYS ago,
 * RETENTION_ENFORCED=true **permanently deletes wedding photos**.
 *
 * The guard still holds in the right order, which was the design intent — an
 * album is deletable only after a notice it could act on. What changed is that
 * the precondition is now reachable. Do not read this constant as a safety net
 * that makes enforcement a no-op; the only thing that still makes it a no-op is
 * an unconfigured mailer (`server/lib/config.ts:155-163`).
 */
export const RETENTION_NOTICE_DAYS = 14;

export interface RetentionCandidate {
  eventId: string;
  slug: string;
  title: string;
  hostEmail: string | null;
  tier: BackendPlanTier;
  expiresAt: string;
  storageBytes: number;
  photoCount: number;
  /** When the host was warned, or null if they never were (D1). */
  notifiedAt: string | null;
  /**
   * Set when this host's address has an uncleared hard bounce (migration 025).
   *
   * Such an album can never be notified, so it can never become deletable. It
   * would otherwise sit in the report forever with no stated reason, and the
   * obvious response to an album that is stuck is to force it through.
   */
  bouncedAt: string | null;
}

export interface SweepResult {
  enforced: boolean;
  expiringSoon: RetentionCandidate[];
  /** Past the grace period AND properly notified — the only albums ever deleted. */
  eligible: RetentionCandidate[];
  /**
   * Past the grace period but not deletable yet, because the host has not been
   * warned or the warning is too recent (D1). Surfaced rather than skipped
   * silently: this list is the work queue for whatever sends the notices, and
   * an album sitting here forever means notification is not running.
   */
  awaitingNotice: RetentionCandidate[];
  deleted: string[];
  freedBytes: number;
  /**
   * Stored objects the adapter refused to delete during a purge.
   *
   * By the time a purge returns, the rows that named these are gone, so nothing
   * in the database can find them again — they are orphans until
   * `storage:orphans` sweeps them. A `console.warn` inside the loop was the
   * only record, which is exactly how 164 MB went unnoticed before. Reported
   * here so the nightly run names them instead.
   */
  leakedPaths: string[];
}

export interface PurgeResult {
  /** Bytes accounted for by the media rows that were removed. */
  freedBytes: number;
  /** Objects the storage adapter refused to delete. See SweepResult.leakedPaths. */
  failedPaths: string[];
}

/**
 * Compute when an album's archive window closes.
 *
 * The window opens when the celebration is over, not when the album was
 * created, so a couple who set things up months in advance does not lose part
 * of what they paid for.
 */
export function computeExpiry(
  tier: BackendPlanTier,
  eventDate: Date | string | null,
  createdAt: Date | string
): Date | null {
  const { retentionDays } = limitsFor(tier);
  if (retentionDays === null) return null;

  const created = new Date(createdAt);
  const celebration = eventDate ? new Date(eventDate) : created;
  const start = celebration.getTime() > created.getTime() ? celebration : created;

  return new Date(start.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Recalculate `expires_at` for every event from its host's current plan.
 *
 * Safe to run repeatedly; an upgrade extends the window on the next pass.
 *
 * Pass `hostUserId` to scope the recompute to one host's own events — used
 * right after a tier upgrade (SEC-05), where touching every event in the
 * table on every single upgrade would be needless write amplification
 * (and, under a burst of concurrent upgrades, needless row-lock contention)
 * for a change that only ever affects that one host's events. The retention
 * sweep script omits it to refresh everyone ahead of the nightly report.
 *
 * `db` lets a caller run this inside an open transaction — the Stripe webhook
 * does, so the expiry recompute commits or rolls back together with the tier
 * write that caused it. Defaults to the pool for every other caller.
 */
export async function refreshExpiryDates(
  hostUserId?: string,
  db: Pool | PoolClient = pool
): Promise<number> {
  const { rows } = await db.query(
    `SELECT e.id, e.event_date, e.created_at,
           COALESCE(s.tier, 'free') AS tier
      FROM events e
      LEFT JOIN subscriptions s
        ON s.user_id = e.host_user_id AND s.status = 'active'
      ${hostUserId ? 'WHERE e.host_user_id = $1' : ''}`,
    hostUserId ? [hostUserId] : []
  );

  if (rows.length === 0) return 0;

  // DB-09: computeExpiry is a pure function - nothing here needs a
  // round-trip per row. One UPDATE...FROM unnest(...) batches every event
  // into a single statement instead of one UPDATE per row.
  // H7 — a tier change recomputes from the *celebration date*, so moving an
  // account to a shorter plan can produce a deadline that has already passed:
  // a wedding six months ago recomputed at the free tier's 7 days lands well
  // in the past, and the next sweep past the grace period treats the album as
  // eligible for deletion. Losing a plan is a billing outcome; losing the
  // photos without warning is not, so no recompute may ever leave an album
  // closer to deletion than the grace period allows from this moment.
  //
  // This is a floor, not a freeze: a shorter plan still shortens retention,
  // it just cannot do so retroactively.
  const floor = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const ids: string[] = [];
  const expiries: (string | null)[] = [];
  for (const row of rows) {
    const expiry = computeExpiry(row.tier as BackendPlanTier, row.event_date, row.created_at);
    ids.push(row.id);
    if (!expiry) {
      // null means indefinite retention (Pro Planner); nothing to floor.
      expiries.push(null);
      continue;
    }
    expiries.push((expiry.getTime() < floor.getTime() ? floor : expiry).toISOString());
  }

  await db.query(
    `UPDATE events SET expires_at = v.expiry
       FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::timestamptz[]) AS expiry) v
      WHERE events.id = v.id`,
    [ids, expiries]
  );

  return rows.length;
}

async function loadCandidates(cutoff: string): Promise<RetentionCandidate[]> {
  const { rows } = await pool.query(
    `SELECT e.id, e.slug, e.title, e.host_email, e.expires_at, e.storage_bytes,
            e.retention_notified_at,
            COALESCE(s.tier, 'free') AS tier,
            (SELECT COUNT(*)::int FROM photos p WHERE p.event_id = e.id) AS photo_count,
            b.bounced_at
       FROM events e
       LEFT JOIN subscriptions s ON s.user_id = e.host_user_id AND s.status = 'active'
       LEFT JOIN email_bounces b
              ON b.email = lower(e.host_email) AND b.kind = 'hard' AND b.cleared_at IS NULL
      WHERE e.expires_at IS NOT NULL AND e.expires_at < $1
      ORDER BY e.expires_at ASC`,
    [cutoff]
  );

  return rows.map((r) => ({
    eventId: r.id,
    slug: r.slug,
    title: r.title,
    hostEmail: r.host_email,
    tier: r.tier,
    expiresAt: new Date(r.expires_at).toISOString(),
    storageBytes: Number(r.storage_bytes) || 0,
    photoCount: r.photo_count,
    notifiedAt: r.retention_notified_at ? new Date(r.retention_notified_at).toISOString() : null,
    bouncedAt: r.bounced_at ? new Date(r.bounced_at).toISOString() : null,
  }));
}

/**
 * Delete every stored object for an event, then its media rows.
 *
 * Files first, and the order is load-bearing: the rows are the only record of
 * which stored objects belong to this album, so deleting them first orphans
 * every file permanently. Files first means a failure leaves rows pointing at
 * missing objects — visible, and fixable — instead of bytes nothing can find.
 *
 * A delete the adapter refuses is *not* fatal here: aborting would leave the
 * album half-purged with no way to resume. It is collected into `failedPaths`
 * so the caller can report it, because the row that named the object is about
 * to be deleted and after that only `storage:orphans` can find it.
 */
export async function purgeEventMedia(eventId: string): Promise<PurgeResult> {
  const { rows: photos } = await pool.query(
    'SELECT storage_path, original_storage_path, thumbnail_url, storage_bytes FROM photos WHERE event_id = $1',
    [eventId]
  );
  const { rows: audio } = await pool.query(
    'SELECT audio_url, storage_bytes FROM audio_guestbook WHERE event_id = $1',
    [eventId]
  );

  let freed = 0;
  const failedPaths: string[] = [];

  const deleteObject = async (path: string): Promise<void> => {
    try {
      await storageAdapter.delete(path);
    } catch (err) {
      failedPaths.push(path);
      console.warn(`[retention] could not delete ${path}:`, errorLabel(err));
    }
  };

  for (const photo of photos) {
    // The thumbnail belongs here too. It was selected but never deleted, so a
    // purged album left its thumbnails in storage permanently - invisible,
    // because nothing referenced them any more, and billed forever on R2.
    const paths = [
      photo.storage_path,
      photo.original_storage_path,
      toStoragePath(photo.thumbnail_url),
    ];
    for (const path of paths) {
      if (!path) continue;
      await deleteObject(path);
    }
    freed += Number(photo.storage_bytes) || 0;
  }

  for (const entry of audio) {
    const path = toStoragePath(entry.audio_url as string);
    if (path) await deleteObject(path);
    freed += Number(entry.storage_bytes) || 0;
  }

  // DB-01: every photo/audio row for this event is being deleted, so the
  // FOR EACH ROW trigger's incremental decrement is redundant work here - a
  // purge with thousands of photos becomes thousands of sequential UPDATEs
  // on the exact same events row (WAL bloat, row-lock contention). Since the
  // whole event's media is going away in this one operation, storage_bytes is
  // known to end at exactly 0 regardless of how many rows fire, so the
  // accounting can be skipped and set directly in one statement.
  //
  // H5: that skip used to be `ALTER TABLE ... DISABLE TRIGGER`, which is
  // correct in effect and badly wrong in cost — ALTER TABLE takes an ACCESS
  // EXCLUSIVE lock on the WHOLE photos table (every event, not just this one)
  // for the length of the transaction, and queues behind any in-flight query.
  // The nightly sweep loops over expired albums, so every live wedding stalled
  // once per purge. It also silently requires table ownership.
  //
  // Migration 020 moves the skip into the trigger function, gated on this
  // transaction-local setting. SET LOCAL needs no privilege, takes no lock at
  // all, and cannot outlive the COMMIT/ROLLBACK — so there is no longer a
  // failure mode where accounting is left switched off for every other event.
  // Scoped to just this bulk-wipe path: a single photo/audio delete elsewhere
  // still fires the trigger normally, which is correct there.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL wedmoments.bulk_purge = 'on'");
    await client.query('DELETE FROM photos WHERE event_id = $1', [eventId]);
    await client.query('DELETE FROM audio_guestbook WHERE event_id = $1', [eventId]);
    await client.query('UPDATE events SET storage_bytes = 0 WHERE id = $1', [eventId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // G4 — every file under events/<eventId>/ is gone at this point; remove
  // the now-empty directory too so it doesn't linger as noise in the next
  // `storage:orphans` report. Best-effort and adapter-optional (R2 has no
  // real directory to remove).
  await storageAdapter.removeEventDirectory?.(eventId);

  return { freedBytes: freed, failedPaths };
}

/**
 * Report — and, when explicitly enforced, act on — expired albums.
 *
 * `enforce` defaults to false. Deleting a couple's wedding photos is not
 * something to do as a side effect of running a maintenance task.
 */
export async function sweepExpiredAlbums(enforce = false): Promise<SweepResult> {
  const now = Date.now();
  const graceCutoff = new Date(now - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const soonCutoff = new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString();

  const pastExpiry = await loadCandidates(soonCutoff);
  const pastGrace = await loadCandidates(graceCutoff);
  const pastGraceIds = new Set(pastGrace.map((c) => c.eventId));

  // D1 — past the grace period is necessary but not sufficient. An album is
  // only deletable once its host has actually been warned and has had
  // RETENTION_NOTICE_DAYS to do something about it. Everything else past grace
  // is reported as awaiting notice, so it is visible rather than quietly
  // skipped: an album stuck in that list means notification is not running.
  const noticeCutoff = Date.now() - RETENTION_NOTICE_DAYS * 24 * 60 * 60 * 1000;
  const isNotified = (c: RetentionCandidate): boolean =>
    c.notifiedAt !== null && new Date(c.notifiedAt).getTime() <= noticeCutoff;

  const eligible = pastGrace.filter(isNotified);
  const awaitingNotice = pastGrace.filter((c) => !isNotified(c));

  const result: SweepResult = {
    enforced: enforce,
    // Expired or expiring within a fortnight, but still inside the grace period.
    expiringSoon: pastExpiry.filter((c) => !pastGraceIds.has(c.eventId)),
    eligible,
    awaitingNotice,
    deleted: [],
    freedBytes: 0,
    leakedPaths: [],
  };

  if (!enforce) return result;

  for (const candidate of eligible) {
    try {
      const purge = await purgeEventMedia(candidate.eventId);
      result.deleted.push(candidate.eventId);
      result.freedBytes += purge.freedBytes;
      result.leakedPaths.push(...purge.failedPaths);
      console.log(
        `[retention] purged media for ${candidate.slug} (expired ${candidate.expiresAt}, ` +
        `freed ${purge.freedBytes} bytes` +
        (purge.failedPaths.length > 0 ? `, ${purge.failedPaths.length} object(s) LEAKED` : '') +
        ')'
      );
    } catch (err) {
      console.error(`[retention] failed to purge ${candidate.slug}:`, err);
    }
  }

  return result;
}
