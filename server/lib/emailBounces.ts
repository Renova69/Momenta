import { pool } from './db';
import type { Pool, PoolClient } from 'pg';

/**
 * Bounced addresses, and what a bounce means for retention.
 *
 * The notice mechanism (migration 024) rests on `retention_notified_at` being
 * evidence that a host was actually warned. A send that the relay accepted and
 * then bounced asynchronously produces that stamp without the warning, which is
 * the one way the guard can be satisfied while its purpose is defeated — and it
 * fails in the worst direction, because an address that has died belongs to the
 * host least able to notice their photographs are about to be destroyed.
 *
 * Two rules, both deliberately biased toward keeping photographs:
 *
 *   1. Recording a hard bounce **clears** `retention_notified_at` on every
 *      album owned by that address. The bounce almost always arrives after the
 *      stamp, so refusing future stamps is not enough — the already-armed album
 *      has to be disarmed.
 *   2. A hard-bounced address is then excluded from `findAlbumsNeedingNotice`,
 *      so the album is never re-stamped. It sits in the retention sweep's
 *      "past grace but NOT deletable" bucket indefinitely, visible in every
 *      report, until a person fixes the address or clears the bounce.
 *
 * The result is an album that cannot be deleted and cannot be quietly
 * forgotten. That is the correct resting state: the alternative to a human
 * looking at it is destroying someone's wedding photographs on the strength of
 * an email that was never read.
 *
 * Nothing expires a hard bounce on its own. "It has been a while" is not
 * evidence an address works.
 */

export type BounceKind = 'hard' | 'soft';

export interface BounceRecord {
  email: string;
  kind: BounceKind;
  bouncedAt: string;
  detail: string | null;
  source: string;
  clearedAt: string | null;
}

export interface RecordBounceInput {
  email: string;
  kind: BounceKind;
  /** Whatever the provider said, kept verbatim. */
  detail?: string | null;
  /** Which provider or person reported it. */
  source?: string;
}

export interface RecordBounceResult {
  email: string;
  kind: BounceKind;
  /** Albums disarmed by this bounce — stamped as notified, now not. */
  unarmedEventIds: string[];
}

/** Addresses are compared case-insensitively; SMTP domains are, and in practice mailboxes are too. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Record a bounce, and disarm anything it contradicts.
 *
 * A hard bounce never downgrades to soft: once an address is known dead, a
 * later transient failure from a retry elsewhere must not quietly re-enable
 * deletion. Upgrading soft to hard is allowed, and re-recording a hard bounce
 * refreshes its detail and un-clears it, because a bounce after someone marked
 * the address fixed means it is not fixed.
 */
export async function recordBounce(
  input: RecordBounceInput,
  db: Pool | PoolClient = pool
): Promise<RecordBounceResult> {
  const email = normaliseEmail(input.email);
  if (!email) throw new Error('recordBounce: email is required');

  const { rows } = await db.query<{ kind: BounceKind }>(
    `INSERT INTO email_bounces (email, kind, detail, source, bounced_at, cleared_at)
          VALUES ($1, $2, $3, $4, NOW(), NULL)
     ON CONFLICT (email) DO UPDATE
            SET kind = CASE
                         WHEN email_bounces.kind = 'hard' THEN 'hard'
                         ELSE EXCLUDED.kind
                       END,
                detail = EXCLUDED.detail,
                source = EXCLUDED.source,
                bounced_at = NOW(),
                cleared_at = NULL
      RETURNING kind`,
    [email, input.kind, input.detail ?? null, input.source ?? 'manual']
  );

  const kind = rows[0].kind;
  if (kind !== 'hard') return { email, kind, unarmedEventIds: [] };

  // The stamp is what permits deletion, and this bounce is proof the warning
  // behind it never arrived. Clearing it is the whole point of this module.
  const { rows: unarmed } = await db.query<{ id: string }>(
    `UPDATE events
        SET retention_notified_at = NULL
      WHERE lower(host_email) = $1
        AND retention_notified_at IS NOT NULL
      RETURNING id`,
    [email]
  );

  return { email, kind, unarmedEventIds: unarmed.map((r) => r.id) };
}

/** Deliberate and manual: someone has corrected the address or confirmed it works. */
export async function clearBounce(email: string, db: Pool | PoolClient = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE email_bounces SET cleared_at = NOW() WHERE email = $1 AND cleared_at IS NULL',
    [normaliseEmail(email)]
  );
  return (rowCount ?? 0) > 0;
}

/** Is this address currently blocked from receiving a notice? */
export async function isHardBounced(email: string, db: Pool | PoolClient = pool): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM email_bounces
      WHERE email = $1 AND kind = 'hard' AND cleared_at IS NULL`,
    [normaliseEmail(email)]
  );
  return rows.length > 0;
}

export async function listBounces(
  includeCleared = false,
  db: Pool | PoolClient = pool
): Promise<BounceRecord[]> {
  const { rows } = await db.query(
    `SELECT email, kind, bounced_at, detail, source, cleared_at
       FROM email_bounces
      ${includeCleared ? '' : 'WHERE cleared_at IS NULL'}
      ORDER BY bounced_at DESC`
  );

  return rows.map((r) => ({
    email: r.email,
    kind: r.kind,
    bouncedAt: new Date(r.bounced_at).toISOString(),
    detail: r.detail,
    source: r.source,
    clearedAt: r.cleared_at ? new Date(r.cleared_at).toISOString() : null,
  }));
}
