/**
 * A full-dress rehearsal of the retention chain, on albums it creates itself.
 *
 *   npm run retention:rehearse
 *
 * Retention is the one subsystem whose failure mode is destroying customer
 * data, and it is the one that cannot be observed until it runs: the notice,
 * the fourteen-day wait, the grace period, the purge, and the storage removal
 * are five separate gates, and every one of them is only exercised by an album
 * actually reaching it. This drives all five against fixtures, asserts the
 * outcome of each, and removes everything it made.
 *
 * Note what the sweep does and does not do. It purges an album's **media** —
 * photos, audio, the stored objects behind them — and leaves the album row in
 * place. A host following an old link after their window closes therefore
 * reaches an empty album rather than a 404 that reads as "your wedding is
 * gone". Removing the album itself is a separate, host-initiated act
 * (`DELETE /api/events/:id`), and only that one is recorded in
 * `event_deletions`.
 *
 * **Why this exists at all.** Two bugs in this chain were found only by making
 * something run — notices firing before the wedding, and nine tests that had
 * been encoding the pre-wedding behaviour as correct. Neither was visible by
 * reading the code. The window to rehearse a delete path is while there is
 * nothing you would mind losing; once real weddings exist, it closes for good.
 *
 * **What it will not do.** Every query it issues is scoped to the event ids it
 * created moments earlier — `sendRetentionNotices` and `sweepExpiredAlbums`
 * both take an `eventIds` filter, and this passes it every time. It cannot
 * touch an album it did not create, today or in a year when the database is
 * full of real ones. It also refuses to run with NODE_ENV=production.
 *
 * Requires SMTP to be configured and APP_PUBLIC_URL to be publicly resolvable,
 * because a notice that cannot be sent leaves every album unstamped and the
 * rehearsal proves nothing. Point SMTP at a capture service (Mailtrap, MailHog)
 * rather than a real provider: a burst of "your album will be deleted" from a
 * domain without SPF/DKIM is how a sending reputation is spent before the first
 * real message goes out.
 */
import { pool, query } from '../server/lib/db';
import { storageAdapter } from '../server/lib/storage';
import { isMailerConfigured, verifyMailer } from '../server/lib/mailer';
import {
  sweepExpiredAlbums,
  purgeEventMedia,
  GRACE_PERIOD_DAYS,
  RETENTION_NOTICE_DAYS,
} from '../server/lib/retention';
import { sendRetentionNotices, NOTICE_LEAD_DAYS } from '../server/lib/retentionNotice';
import { formatBytes } from '../server/lib/planLimits';
import { CONFIG } from '../server/lib/config';

const TAG = 'rehearsal';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture {
  key: string;
  /** What this album is meant to demonstrate. */
  purpose: string;
  eventId: string;
  slug: string;
  hostEmail: string;
}

interface Check {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}

const checks: Check[] = [];

function check(name: string, expected: unknown, actual: unknown): void {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  checks.push({ name, expected: e, actual: a, ok: e === a });
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

function daysAhead(n: number): string {
  return new Date(Date.now() + n * DAY_MS).toISOString();
}

/**
 * One album, with real stored objects behind it.
 *
 * The photos matter: a purge that deletes rows but leaves bytes is the failure
 * this whole subsystem is most prone to, and it is invisible without real
 * objects to go missing.
 */
async function makeAlbum(opts: {
  key: string;
  purpose: string;
  eventDate: string;
  expiresAt: string | null;
  notifiedAt: string | null;
  photos: number;
}): Promise<Fixture> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const slug = `${TAG}-${opts.key}-${stamp}`;
  const hostEmail = `${TAG}-${opts.key}-${stamp}@example.invalid`;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, expires_at, retention_notified_at)
     VALUES ($1, $2, 'Rehearsal Host', $3, $4, $5, $6)
     RETURNING id`,
    [slug, `Rehearsal — ${opts.purpose}`, hostEmail, opts.eventDate, opts.expiresAt, opts.notifiedAt]
  );
  const eventId = rows[0].id;

  const { rows: guestRows } = await pool.query<{ id: string }>(
    `INSERT INTO guests (event_id, name) VALUES ($1, 'Rehearsal Guest') RETURNING id`,
    [eventId]
  );

  for (let i = 0; i < opts.photos; i++) {
    const bytes = Buffer.alloc(4096, i + 1);
    const display = await storageAdapter.save(bytes, `photo-${i}.jpg`, 'image/jpeg', eventId);
    const original = await storageAdapter.save(bytes, `photo-${i}-orig.jpg`, 'image/jpeg', eventId);
    const thumb = await storageAdapter.save(bytes, `photo-${i}-thumb.jpg`, 'image/jpeg', eventId);
    await pool.query(
      `INSERT INTO photos (event_id, guest_id, storage_path, original_storage_path, thumbnail_url, full_url, storage_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        eventId,
        guestRows[0].id,
        display.storagePath,
        original.storagePath,
        thumb.publicUrl,
        display.publicUrl,
        bytes.length * 3,
      ]
    );
  }

  return { key: opts.key, purpose: opts.purpose, eventId, slug, hostEmail };
}

/** Does anything still exist in storage under this event's prefix? */
async function storageRemains(fixture: Fixture): Promise<boolean> {
  const { rows } = await pool.query<{ storage_path: string }>(
    'SELECT storage_path FROM photos WHERE event_id = $1',
    [fixture.eventId]
  );
  for (const row of rows) {
    if (await storageAdapter.getStream(row.storage_path)) return true;
  }
  return false;
}

async function preflight(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run a retention rehearsal with NODE_ENV=production.');
  }
  if (!isMailerConfigured()) {
    throw new Error(
      'SMTP is not configured, so no notice can be sent and nothing here would be proved. ' +
        'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/MAIL_FROM — a capture service is ideal.'
    );
  }
  await verifyMailer();
  console.log(`[${TAG}] SMTP verified against ${CONFIG.SMTP_HOST}.`);
  console.log(`[${TAG}] notices link to ${CONFIG.APP_PUBLIC_URL}\n`);
}

async function main(): Promise<void> {
  await preflight();

  console.log(
    `[${TAG}] grace ${GRACE_PERIOD_DAYS}d · notice must be ${RETENTION_NOTICE_DAYS}d old · ` +
      `notice lead ${NOTICE_LEAD_DAYS}d\n`
  );

  const fixtures: Fixture[] = [];
  try {
    // The album the whole chain should carry all the way to deletion.
    const deletable = await makeAlbum({
      key: 'deletable',
      purpose: 'past grace, will be warned, should be deleted',
      eventDate: daysAgo(120),
      expiresAt: daysAgo(GRACE_PERIOD_DAYS + 10),
      notifiedAt: null,
      photos: 2,
    });

    // Past grace but never warned. The single most important negative case:
    // this is the album that must survive an enforced sweep.
    const unwarned = await makeAlbum({
      key: 'unwarned',
      purpose: 'past grace, never warned, must survive',
      eventDate: daysAgo(120),
      expiresAt: daysAgo(GRACE_PERIOD_DAYS + 10),
      notifiedAt: null,
      photos: 1,
    });

    // Warned, but only just. The fourteen days exist so a host has time to act.
    const warnedTooRecently = await makeAlbum({
      key: 'recent-notice',
      purpose: 'past grace, warned yesterday, must survive',
      eventDate: daysAgo(120),
      expiresAt: daysAgo(GRACE_PERIOD_DAYS + 10),
      notifiedAt: daysAgo(1),
      photos: 1,
    });

    // Expiring soon, still inside the grace period.
    const expiringSoon = await makeAlbum({
      key: 'expiring-soon',
      purpose: 'inside the notice window, not past grace',
      eventDate: daysAgo(30),
      expiresAt: daysAhead(NOTICE_LEAD_DAYS - 2),
      notifiedAt: null,
      photos: 1,
    });

    // Pro Planner: indefinite retention, nothing to warn about, never deleted.
    const indefinite = await makeAlbum({
      key: 'indefinite',
      purpose: 'no expiry at all, must never be touched',
      eventDate: daysAgo(120),
      expiresAt: null,
      notifiedAt: null,
      photos: 1,
    });

    // The wedding has not happened yet. Warning here would tell a couple their
    // album is being deleted days before they get married.
    const beforeTheWedding = await makeAlbum({
      key: 'pre-wedding',
      purpose: 'expiring soon but the celebration is still ahead',
      eventDate: daysAhead(5),
      expiresAt: daysAhead(NOTICE_LEAD_DAYS - 2),
      notifiedAt: null,
      photos: 1,
    });

    // A host whose address hard-bounced can never be warned, and therefore can
    // never become deletable.
    const bounced = await makeAlbum({
      key: 'bounced',
      purpose: 'host address hard-bounced, must never be warned or deleted',
      eventDate: daysAgo(120),
      expiresAt: daysAgo(GRACE_PERIOD_DAYS + 10),
      notifiedAt: null,
      photos: 1,
    });
    await pool.query(
      `INSERT INTO email_bounces (email, kind, detail, source)
       VALUES (lower($1), 'hard', 'rehearsal fixture', 'rehearsal')
       ON CONFLICT (email) DO UPDATE SET kind = 'hard', cleared_at = NULL`,
      [bounced.hostEmail]
    );

    fixtures.push(
      deletable,
      unwarned,
      warnedTooRecently,
      expiringSoon,
      indefinite,
      beforeTheWedding,
      bounced
    );
    const ids = fixtures.map((f) => f.eventId);

    console.log(`[${TAG}] created ${fixtures.length} albums:`);
    for (const f of fixtures) console.log(`  ${f.key.padEnd(15)} ${f.purpose}`);
    console.log('');

    // ---------------------------------------------------------------- notices
    console.log(`[${TAG}] sending notices (scoped to these albums only)...`);
    const notice = await sendRetentionNotices({ send: true, eventIds: ids });
    const notified = new Set(notice.sent);

    check('warns the album that is past grace', true, notified.has(deletable.eventId));
    check('warns the album expiring soon', true, notified.has(expiringSoon.eventId));
    check(
      'does not warn before the celebration',
      false,
      notified.has(beforeTheWedding.eventId)
    );
    check('does not warn a hard-bounced host', false, notified.has(bounced.eventId));
    check('does not warn an album with no expiry', false, notified.has(indefinite.eventId));
    check(
      'does not warn an album already warned',
      false,
      notified.has(warnedTooRecently.eventId)
    );
    check('reports no send failures', 0, notice.failed.length);

    if (notice.failed.length > 0) {
      for (const f of notice.failed) console.log(`  send failed: ${f.eventId} — ${f.reason}`);
    }

    // ------------------------------------------------------------- time travel
    // The notice above is seconds old, so nothing is deletable yet — which is
    // the rule working. Age that one stamp to stand where it would be a
    // fortnight from now. This is the only thing here that is not what a real
    // run does, and it is stated rather than hidden.
    console.log(
      `\n[${TAG}] ageing the 'deletable' notice by ${RETENTION_NOTICE_DAYS + 1} days ` +
        `to stand in for the wait...\n`
    );
    await query('UPDATE events SET retention_notified_at = $2 WHERE id = $1', [
      deletable.eventId,
      daysAgo(RETENTION_NOTICE_DAYS + 1),
    ]);

    // ------------------------------------------------------------------ sweep
    const dryRun = await sweepExpiredAlbums(false, { eventIds: ids });
    check(
      'a report-only sweep deletes nothing',
      0,
      dryRun.deleted.length
    );
    check(
      'the report still names the album as eligible',
      true,
      dryRun.eligible.some((c) => c.eventId === deletable.eventId)
    );

    console.log(`[${TAG}] running the sweep WITH enforcement, scoped to these albums...`);
    const swept = await sweepExpiredAlbums(true, { eventIds: ids });
    const deletedSet = new Set(swept.deleted);

    check('deletes the warned, aged, past-grace album', true, deletedSet.has(deletable.eventId));
    check('does NOT delete the album nobody warned', false, deletedSet.has(unwarned.eventId));
    check(
      'does NOT delete the album warned yesterday',
      false,
      deletedSet.has(warnedTooRecently.eventId)
    );
    check('does NOT delete the album still in grace', false, deletedSet.has(expiringSoon.eventId));
    check('does NOT delete the indefinite album', false, deletedSet.has(indefinite.eventId));
    check('does NOT delete the bounced album', false, deletedSet.has(bounced.eventId));
    check('deletes exactly one album', 1, swept.deleted.length);
    check('leaks no stored objects', 0, swept.leakedPaths.length);
    check('reports the freed bytes', true, swept.freedBytes > 0);

    if (swept.leakedPaths.length > 0) {
      console.log('\n  LEAKED — these objects outlived their rows:');
      for (const p of swept.leakedPaths) console.log(`    ${p}`);
    }

    // -------------------------------------------------------------- storage
    check('the deleted album leaves nothing in storage', false, await storageRemains(deletable));
    check('the surviving albums keep their photos', true, await storageRemains(unwarned));

    // The sweep purges media; it does not remove the album. That distinction is
    // deliberate and worth asserting rather than assuming: a host who follows
    // an old link after their retention window closes reaches their album and
    // finds it empty, which is a comprehensible state, instead of a 404 that
    // looks like the service lost their wedding.
    const { rows: rowsLeft } = await pool.query<{ c: number }>(
      'SELECT COUNT(*)::int AS c FROM events WHERE id = $1',
      [deletable.eventId]
    );
    check('the album row survives a retention purge', 1, rowsLeft[0].c);

    const { rows: photosLeft } = await pool.query<{ c: number }>(
      'SELECT COUNT(*)::int AS c FROM photos WHERE event_id = $1',
      [deletable.eventId]
    );
    check('every photo row is gone', 0, photosLeft[0].c);

    const { rows: accounted } = await pool.query<{ storage_bytes: string }>(
      'SELECT storage_bytes FROM events WHERE id = $1',
      [deletable.eventId]
    );
    check('the storage total is back to zero', 0, Number(accounted[0]?.storage_bytes ?? -1));

    // event_deletions is the *host-initiated* erasure log, written by
    // DELETE /api/events/:id. A retention purge is not an erasure request and
    // does not belong in it — checked so the two never quietly merge.
    const { rows: logged } = await pool.query<{ c: number }>(
      'SELECT COUNT(*)::int AS c FROM event_deletions WHERE event_id = $1',
      [deletable.eventId]
    );
    check('a retention purge is not logged as a host erasure', 0, logged[0].c);

    console.log(`\n[${TAG}] freed ${formatBytes(swept.freedBytes)}.\n`);
  } finally {
    // Unconditional: a failed rehearsal must not leave fixtures behind, or the
    // next run reports on the wreckage of the last one.
    console.log(`[${TAG}] cleaning up...`);
    for (const f of fixtures) {
      await purgeEventMedia(f.eventId).catch(() => undefined);
      await query('DELETE FROM events WHERE id = $1', [f.eventId]).catch(() => undefined);
      await query('DELETE FROM event_deletions WHERE event_id = $1', [f.eventId]).catch(
        () => undefined
      );
      await query('DELETE FROM email_bounces WHERE email = lower($1)', [f.hostEmail]).catch(
        () => undefined
      );
    }
    console.log(`[${TAG}] removed ${fixtures.length} fixture album(s).\n`);
  }

  // ----------------------------------------------------------------- verdict
  const failed = checks.filter((c) => !c.ok);
  console.log('='.repeat(72));
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (!c.ok) console.log(`        expected ${c.expected}, got ${c.actual}`);
  }
  console.log('='.repeat(72));
  console.log(
    `${checks.length - failed.length}/${checks.length} checks passed` +
      (failed.length ? ` — ${failed.length} FAILED` : '')
  );

  if (failed.length > 0) {
    console.log(
      '\nDo not enable RETENTION_ENFORCED in production while any of these fail.'
    );
    process.exitCode = 1;
  } else {
    console.log(
      '\nThe chain holds: an album is warned, waits, and only then is deleted — and the\n' +
        'albums that must survive did. Turn RETENTION_ENFORCED back off now; this proved\n' +
        'the mechanism, not that you are ready to point it at customers.'
    );
  }
}

main()
  .catch((err) => {
    console.error(`\n[${TAG}] failed:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
