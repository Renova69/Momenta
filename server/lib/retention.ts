import { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { isStoredAvatarUrl, isStoredCoverUrl, storageAdapter, toStoragePath } from './storage';
import { limitsFor } from './planLimits';
import { errorLabel } from './errors';
import { BackendPlanTier, acquireEventUploadLock, higherTier } from '../middleware/tierGate';

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
 *
 * N-169 — and not before the plan was bought: `boughtAt`, when given, is the
 * purchase of the pass that sets this window, and a plan gives its days from
 * the wedding or from the purchase, whichever is later. Counted from the
 * wedding alone, a pass bought for a wedding months gone was already over.
 */
export function computeExpiry(
  tier: BackendPlanTier,
  eventDate: Date | string | null,
  createdAt: Date | string,
  boughtAt?: Date | string | null
): Date | null {
  const { retentionDays } = limitsFor(tier);
  if (retentionDays === null) return null;

  const created = new Date(createdAt);
  const celebration = eventDate ? new Date(eventDate) : created;
  const bought = boughtAt ? new Date(boughtAt).getTime() : 0;
  const start = Math.max(celebration.getTime(), created.getTime(), bought);

  return new Date(start + retentionDays * 24 * 60 * 60 * 1000);
}

export interface ExpiryRefreshOptions {
  /**
   * N-168 — only a payment may reopen a closed album. Left off, a recompute
   * keeps every deadline that has already passed: the wedding date can be
   * edited at will, so a recompute from it must not move a closed album's
   * deadline into the future.
   */
  allowReopen?: boolean;
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
  db: Pool | PoolClient = pool,
  options: ExpiryRefreshOptions = {}
): Promise<number> {
  const { rows } = await db.query(
    `SELECT e.id, e.event_date, e.created_at, e.expires_at, e.pass_tier, e.pass_started_at,
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
  //
  // N-34 — and the floor is capped by the deadline the album already has. It
  // exists to stop a recompute pulling a deadline closer; it must never push
  // one further away. Measured from `now` alone, it did exactly that: this
  // runs nightly for every album, so any album inside 30 days of its deadline
  // was moved back to 30 days out every night — no notice ever fell due and
  // nothing ever reached grace. Capped, an album floored once stays put, and
  // one that expired on its own plan stays expired.
  const now = Date.now();
  const floor = now + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

  const ids: string[] = [];
  const expiries: (string | null)[] = [];
  for (const row of rows) {
    ids.push(row.id);
    // N-168 — a closed album stays closed unless a payment caused this.
    if (!options.allowReopen && row.expires_at && new Date(row.expires_at).getTime() <= now) {
      expiries.push(new Date(row.expires_at).toISOString());
      continue;
    }
    // The album's own pass (N-168) counts as well as the account's plan, and
    // when it is what sets the window, its days start no earlier than its
    // purchase (N-169).
    const tier = higherTier(row.tier, row.pass_tier);
    const boughtAt = row.pass_tier && tier === row.pass_tier ? row.pass_started_at : null;
    const expiry = computeExpiry(tier, row.event_date, row.created_at, boughtAt);
    if (!expiry) {
      // null means indefinite retention (Pro Planner); nothing to floor.
      expiries.push(null);
      continue;
    }
    // A null stored expiry was indefinite, so the full floor applies.
    const current = row.expires_at ? new Date(row.expires_at).getTime() : Infinity;
    const cappedFloor = Math.min(current, floor);
    expiries.push(new Date(Math.max(expiry.getTime(), cappedFloor)).toISOString());
  }

  // N-64 — a retention warning is about one deadline. When the deadline moves
  // — a purchase extends it, a lapse shortens it, indefinite becomes dated —
  // the warning no longer describes it, so it is forgotten and a fresh one is
  // due. It was stamped once and never cleared: an album warned, extended,
  // then lapsed again counted as warned about a deadline nobody had told the
  // host about. A second of slack absorbs the difference between microsecond
  // rows and millisecond values from here, which is not a move.
  await db.query(
    `UPDATE events SET
            retention_notified_at = CASE
              WHEN (v.expiry IS NULL) <> (events.expires_at IS NULL)
                OR abs(extract(epoch FROM (v.expiry - events.expires_at))) > 1
              THEN NULL
              ELSE events.retention_notified_at
            END,
            expires_at = v.expiry
       FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::timestamptz[]) AS expiry) v
      WHERE events.id = v.id`,
    [ids, expiries]
  );

  return rows.length;
}

/**
 * How often a purge renews its deletion mark (N-73). Uploads stop honouring a
 * mark an hour old, taking it for a deletion that crashed, and the purge of a
 * very large album can run longer than that.
 */
const DELETION_MARK_RENEW_MS = 5 * 60 * 1000;

/** How often a purge asks whether its album is still to be deleted (N-101). */
const STILL_WANTED_CHECK_MS = 1000;

/** Raised when the album stopped being deletable part way through its purge. */
export class PurgeNoLongerWanted extends Error {
  constructor(eventId: string) {
    super(`[retention] ${eventId} is no longer to be deleted; purge stopped`);
    this.name = 'PurgeNoLongerWanted';
  }
}

export interface PurgeOptions {
  /**
   * Asked between file deletes, at most once a second, and once more before
   * the rows go: false stops the purge (N-101). A host who extends an album
   * while the retention sweep is purging it must not lose it.
   */
  stillWanted?: () => Promise<boolean>;
}

/**
 * Claim an album's deletion mark, so uploads are refused until it is taken
 * off (N-47). Stamped under the album's upload lock: an upload holding the
 * lock now commits first, and one taking it later sees the mark.
 *
 * False when another deletion holds a live mark. Two deletions sharing one
 * mark each took it off on the way out, reopening uploads under the other's
 * purge. A mark an hour old belongs to a deletion that crashed, and is taken
 * over — the same age at which getUploadContext stops honouring it.
 */
/**
 * A deletion mark as its holder knows it: the exact time it wrote (N-100).
 * The mark is only a time, so two deletions could not tell theirs apart; a
 * holder now renews and clears only a mark that still carries its time.
 * `purgeEventMedia` updates `token` as it renews.
 */
export interface DeletionMark {
  eventId: string;
  token: string;
}

export async function markEventDeleting(eventId: string): Promise<DeletionMark | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireEventUploadLock(client, eventId);
    const { rows } = await client.query<{ token: string }>(
      `UPDATE events SET deleting_at = NOW()
        WHERE id = $1 AND (deleting_at IS NULL OR deleting_at < NOW() - INTERVAL '1 hour')
        RETURNING deleting_at::text AS token`,
      [eventId]
    );
    await client.query('COMMIT');
    return rows[0] ? { eventId, token: rows[0].token } : null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Let an album take uploads again: its purge failed, or it outlives its media.
 * Only the holder's own mark is taken off; one another deletion took over is
 * left alone (N-100).
 */
export async function clearDeletionMark(mark: DeletionMark): Promise<void> {
  await pool.query('UPDATE events SET deleting_at = NULL WHERE id = $1 AND deleting_at = $2::timestamptz', [
    mark.eventId,
    mark.token,
  ]);
}

async function loadCandidates(
  cutoff: string,
  eventIds?: string[]
): Promise<RetentionCandidate[]> {
  const { rows } = await pool.query(
    `SELECT e.id, e.slug, e.title, e.host_email, e.expires_at, e.storage_bytes,
            e.retention_notified_at,
            COALESCE(s.tier, 'free') AS tier, e.pass_tier,
            (SELECT COUNT(*)::int FROM photos p WHERE p.event_id = e.id) AS photo_count,
            b.bounced_at
       FROM events e
       LEFT JOIN subscriptions s ON s.user_id = e.host_user_id AND s.status = 'active'
       LEFT JOIN email_bounces b
              ON b.email = lower(e.host_email) AND b.kind = 'hard' AND b.cleared_at IS NULL
      WHERE e.expires_at IS NOT NULL AND e.expires_at < $1
        AND ($2::uuid[] IS NULL OR e.id = ANY($2))
      ORDER BY e.expires_at ASC`,
    [cutoff, eventIds ?? null]
  );

  return rows.map((r) => ({
    eventId: r.id,
    slug: r.slug,
    title: r.title,
    hostEmail: r.host_email,
    tier: higherTier(r.tier, r.pass_tier),
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
export async function purgeEventMedia(
  eventId: string,
  mark?: DeletionMark,
  options: PurgeOptions = {}
): Promise<PurgeResult> {
  const { rows: photos } = await pool.query(
    'SELECT storage_path, original_storage_path, thumbnail_url, storage_bytes FROM photos WHERE event_id = $1',
    [eventId]
  );
  const { rows: audio } = await pool.query(
    'SELECT audio_url, storage_bytes FROM audio_guestbook WHERE event_id = $1',
    [eventId]
  );
  // N-107 — guests' selfies are stored under the album too. Only a file the
  // avatar route wrote is deleted as one; anything else in the column is not
  // a selfie, and a photo's file is deleted through the photo's own row.
  const { rows: guests } = await pool.query<{ avatar_url: string | null }>(
    'SELECT avatar_url FROM guests WHERE event_id = $1 AND avatar_url IS NOT NULL',
    [eventId]
  );
  // N-139 — and the album's cover, the copy the cover route stored.
  const { rows: covers } = await pool.query<{ cover_image_url: string | null }>(
    'SELECT cover_image_url FROM events WHERE id = $1',
    [eventId]
  );

  let freed = 0;
  const failedPaths: string[] = [];

  // N-73 — a caller that marked the album must keep holding its mark for as
  // long as this runs. Both callers in the app pass the mark they took; the
  // maintenance scripts purge albums nobody marked, and pass none.

  // Renew the mark, or stop. A purge whose mark lapsed has uploads landing in
  // an album it is emptying, which is the drift the mark exists to prevent:
  // a renewal that failed, or a mark someone else took off, used to be
  // logged or ignored and the purge carried on (found by the security review
  // of e38d95b). Stopping leaves rows naming deleted files — visible, and
  // finished by the next attempt.
  // Only the mark this purge holds: one another deletion took over is not
  // this purge's to renew or to work under (N-100).
  const holdMark = async (db: Pool | PoolClient): Promise<void> => {
    if (!mark) return;
    const { rows } = await db.query<{ token: string }>(
      `UPDATE events SET deleting_at = NOW()
        WHERE id = $1 AND deleting_at = $2::timestamptz
        RETURNING deleting_at::text AS token`,
      [eventId, mark.token]
    );
    if (!rows[0]) throw new Error(`[retention] the deletion mark for ${eventId} was taken off; purge stopped`);
    mark.token = rows[0].token;
  };
  let renewedAt = Date.now();
  const renewMark = async (): Promise<void> => {
    if (!mark || Date.now() - renewedAt < DELETION_MARK_RENEW_MS) return;
    await holdMark(pool);
    renewedAt = Date.now();
  };

  let checkedAt = Date.now();
  const confirmWanted = async (force = false): Promise<void> => {
    if (!options.stillWanted) return;
    if (!force && Date.now() - checkedAt < STILL_WANTED_CHECK_MS) return;
    checkedAt = Date.now();
    if (!(await options.stillWanted())) throw new PurgeNoLongerWanted(eventId);
  };

  const deleteObject = async (path: string): Promise<void> => {
    await confirmWanted();
    await renewMark();
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

  for (const guest of guests) {
    if (!isStoredAvatarUrl(guest.avatar_url, eventId)) continue;
    const path = toStoragePath(guest.avatar_url);
    if (path) await deleteObject(path);
  }

  const cover = covers[0]?.cover_image_url;
  if (isStoredCoverUrl(cover, eventId)) {
    const path = toStoragePath(cover);
    if (path) await deleteObject(path);
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
  await confirmWanted(true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Still held, in the same transaction as the delete that relies on it.
    await holdMark(client);
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
export interface SweepOptions {
  /**
   * Restrict the sweep to these event ids.
   *
   * Exists for tests. This function is database-wide by design — a nightly run
   * must consider every expired album — but the spec files that exercise it run
   * against one shared database under vitest's file parallelism, and one of
   * them calls `sweepExpiredAlbums(true)`, which deletes. Unscoped, that spec
   * can destroy albums another spec file created and is still asserting on.
   *
   * Keyed on event id rather than host address so an album with no host email
   * — which one spec creates deliberately — is still reachable when scoped.
   *
   * Production callers omit it and behave exactly as before.
   */
  eventIds?: string[];
}

export async function sweepExpiredAlbums(
  enforce = false,
  options: SweepOptions = {}
): Promise<SweepResult> {
  const now = Date.now();
  const graceCutoff = new Date(now - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const soonCutoff = new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString();

  const pastExpiry = await loadCandidates(soonCutoff, options.eventIds);
  const pastGrace = await loadCandidates(graceCutoff, options.eventIds);
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
    // N-73 — uploads are refused while the album is purged, as when a host
    // deletes it. Without the mark, a photo landing mid-purge lost its row
    // and kept its file.
    let claimed: DeletionMark | null;
    try {
      claimed = await markEventDeleting(candidate.eventId);
    } catch (err) {
      console.error(`[retention] could not mark ${candidate.slug} for deletion, skipped:`, err);
      continue;
    }
    if (!claimed) {
      // Its host is deleting it, and the mark is theirs to take off.
      console.log(`[retention] ${candidate.slug} is already being deleted, skipped`);
      continue;
    }
    try {
      // N-74 — the list was read before the albums ahead of this one were
      // purged, which can take hours. Its host may have extended it since.
      const [current] = await loadCandidates(graceCutoff, [candidate.eventId]);
      if (!current || !isNotified(current)) {
        console.log(`[retention] ${candidate.slug} is no longer deletable, skipped`);
        continue;
      }
      const stillDeletable = async (): Promise<boolean> => {
        const [now] = await loadCandidates(graceCutoff, [candidate.eventId]);
        return !!now && isNotified(now);
      };
      const purge = await purgeEventMedia(candidate.eventId, claimed, { stillWanted: stillDeletable });
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
      if (err instanceof PurgeNoLongerWanted) {
        // Extended part way through: what was already deleted cannot come
        // back, but the rest of the album is kept.
        console.error(`[retention] ${candidate.slug} was extended during its purge; stopped`);
      } else {
        console.error(`[retention] failed to purge ${candidate.slug}:`, err);
      }
    } finally {
      // The album itself stays; only its media went.
      await clearDeletionMark(claimed).catch((err) =>
        console.error(`[retention] could not clear the deletion mark for ${candidate.slug}:`, err)
      );
    }
  }

  return result;
}
