import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

const sent: { to: string }[] = [];

vi.mock('../../server/lib/mailer', () => ({
  isMailerConfigured: () => true,
  verifyMailer: async () => undefined,
  resetMailer: () => undefined,
  sendMail: async (m: { to: string }) => {
    sent.push(m);
  },
}));

import { authRouter } from '../../server/routes/auth';
import {
  recordBounce,
  clearBounce,
  isHardBounced,
  listBounces,
  normaliseEmail,
} from '../../server/lib/emailBounces';
import { sendRetentionNotices, NOTICE_LEAD_DAYS } from '../../server/lib/retentionNotice';
import { sweepExpiredAlbums, GRACE_PERIOD_DAYS, RETENTION_NOTICE_DAYS } from '../../server/lib/retention';
import { query } from '../../server/lib/db';

/**
 * A bounced warning is not a warning.
 *
 * `events.retention_notified_at` is what permits deletion, and the notice
 * sender stamps it after the transport accepts the message. That acceptance is
 * weaker than it looks: a relay returns 250 and then bounces asynchronously
 * when the receiving server refuses the address. Nothing saw that, so the album
 * was armed and the photographs were deleted a fortnight later on the strength
 * of a notice that was never delivered — and the host whose address had died
 * was the one least able to notice it happening.
 *
 * The property under test is therefore not "we store bounces". It is that a
 * bounce **disarms an album that was already stamped**, and that the address
 * can never re-arm it. The bounce almost always arrives after the stamp, so
 * merely refusing future sends would leave exactly the albums at risk that this
 * is meant to protect.
 */

const TEST_PORT = 6651;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];
const createdEmails: string[] = [];

async function registerHost(): Promise<{ eventId: string; email: string; slug: string }> {
  const email = `bounce-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Bounce Spec Host', password: 'Password123!' }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  createdEmails.push(email.toLowerCase());
  return { eventId: data.event.id, email, slug: data.event.slug };
}

/**
 * Inside the notice window, with the celebration already behind them —
 * registration puts `event_date` 30 days out, and a notice is only due once the
 * wedding has actually happened (see findAlbumsNeedingNotice).
 */
async function expiringSoon(eventId: string): Promise<void> {
  await query(
    `UPDATE events
        SET expires_at = NOW() + INTERVAL '${Math.max(1, NOTICE_LEAD_DAYS - 2)} days',
            event_date = NOW() - INTERVAL '1 day'
      WHERE id = $1`,
    [eventId]
  );
}

/** Past expiry and past grace, with an aged notice — i.e. deletable. */
async function armedForDeletion(eventId: string): Promise<void> {
  await query(
    `UPDATE events
        SET expires_at = NOW() - INTERVAL '${GRACE_PERIOD_DAYS + 5} days',
            retention_notified_at = NOW() - INTERVAL '${RETENTION_NOTICE_DAYS + 1} days',
            event_date = NOW() - INTERVAL '${GRACE_PERIOD_DAYS + 12} days'
      WHERE id = $1`,
    [eventId]
  );
}

async function notifiedAt(eventId: string): Promise<string | null> {
  const r = await query<{ retention_notified_at: string | null }>(
    'SELECT retention_notified_at FROM events WHERE id = $1',
    [eventId]
  );
  return r.rows[0]?.retention_notified_at ?? null;
}

describe('email bounces', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    await query('DELETE FROM email_bounces WHERE email = ANY($1::text[])', [createdEmails]).catch(
      () => undefined
    );
    if (server) server.close();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  describe('the property everything else rests on', () => {
    it('disarms an album that was already stamped as notified', async () => {
      // The whole point. The bounce arrives after the stamp, so refusing
      // future sends would not have saved this album.
      const host = await registerHost();
      await armedForDeletion(host.eventId);
      expect(await notifiedAt(host.eventId)).not.toBeNull();

      const result = await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });

      expect(result.unarmedEventIds).toContain(host.eventId);
      expect(await notifiedAt(host.eventId)).toBeNull();
    });

    it('takes the album back out of the deletable set', async () => {
      // Stated against the sweep rather than the column, because the column is
      // an implementation detail and "will not be deleted" is the promise.
      const host = await registerHost();
      await armedForDeletion(host.eventId);

      const before = await sweepExpiredAlbums(false, { eventIds: createdEvents });
      expect(before.eligible.map((c) => c.eventId)).toContain(host.eventId);

      await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });

      const after = await sweepExpiredAlbums(false, { eventIds: createdEvents });
      expect(after.eligible.map((c) => c.eventId)).not.toContain(host.eventId);
      expect(after.awaitingNotice.map((c) => c.eventId)).toContain(host.eventId);
    });

    it('never lets the album be re-armed while the address is blocked', async () => {
      // Otherwise the next nightly run stamps it straight back.
      const host = await registerHost();
      await expiringSoon(host.eventId);
      await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });

      const result = await sendRetentionNotices({ send: true, eventIds: createdEvents });

      expect(result.pending.map((c) => c.eventId)).not.toContain(host.eventId);
      expect(sent.map((m) => m.to)).not.toContain(host.email);
      expect(await notifiedAt(host.eventId)).toBeNull();
    });

    it('says why the album is stuck, so it is not mistaken for a bug', async () => {
      const host = await registerHost();
      await armedForDeletion(host.eventId);
      await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });

      const result = await sweepExpiredAlbums(false, { eventIds: createdEvents });
      const stuck = result.awaitingNotice.find((c) => c.eventId === host.eventId);

      expect(stuck?.bouncedAt).not.toBeNull();
    });
  });

  describe('soft bounces', () => {
    it('do not block, because transient means retry', async () => {
      const host = await registerHost();
      await expiringSoon(host.eventId);

      await recordBounce({ email: host.email, kind: 'soft', detail: 'mailbox full', source: 'spec' });
      const result = await sendRetentionNotices({ send: true, eventIds: createdEvents });

      expect(result.sent).toContain(host.eventId);
      expect(await isHardBounced(host.email)).toBe(false);
    });

    it('do not disarm anything', async () => {
      const host = await registerHost();
      await armedForDeletion(host.eventId);

      const result = await recordBounce({ email: host.email, kind: 'soft', source: 'spec' });

      expect(result.unarmedEventIds).toEqual([]);
      expect(await notifiedAt(host.eventId)).not.toBeNull();
    });

    it('never downgrade a hard bounce', async () => {
      // A retry from somewhere else failing transiently must not quietly
      // re-enable deletion for an address already known to be dead.
      const host = await registerHost();
      await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });

      await recordBounce({ email: host.email, kind: 'soft', source: 'spec' });

      expect(await isHardBounced(host.email)).toBe(true);
    });

    it('are upgraded by a later hard bounce', async () => {
      const host = await registerHost();
      await recordBounce({ email: host.email, kind: 'soft', source: 'spec' });

      await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });

      expect(await isHardBounced(host.email)).toBe(true);
    });
  });

  describe('clearing', () => {
    it('lets the album be notified again', async () => {
      const host = await registerHost();
      await expiringSoon(host.eventId);
      await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });

      expect(await clearBounce(host.email)).toBe(true);
      const result = await sendRetentionNotices({ send: true, eventIds: createdEvents });

      expect(result.sent).toContain(host.eventId);
    });

    it('is undone by a fresh bounce, because that address is evidently not fixed', async () => {
      const host = await registerHost();
      await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });
      await clearBounce(host.email);

      await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });

      expect(await isHardBounced(host.email)).toBe(true);
    });

    it('reports when there was nothing to clear', async () => {
      expect(await clearBounce(`never-bounced-${Date.now()}@test.com`)).toBe(false);
    });

    it('nothing expires a hard bounce on its own', async () => {
      // "It has been a while" is not evidence an address works, so an old
      // bounce blocks exactly as hard as a new one.
      const host = await registerHost();
      await recordBounce({ email: host.email, kind: 'hard', source: 'spec' });
      await query("UPDATE email_bounces SET bounced_at = NOW() - INTERVAL '3 years' WHERE email = $1", [
        host.email.toLowerCase(),
      ]);

      expect(await isHardBounced(host.email)).toBe(true);
    });
  });

  describe('addresses', () => {
    it('are matched case-insensitively', async () => {
      const host = await registerHost();
      await expiringSoon(host.eventId);

      await recordBounce({ email: host.email.toUpperCase(), kind: 'hard', source: 'spec' });

      expect(await isHardBounced(host.email)).toBe(true);
      const result = await sendRetentionNotices({ send: true, eventIds: createdEvents });
      expect(result.pending.map((c) => c.eventId)).not.toContain(host.eventId);
    });

    it('are normalised on the way in', () => {
      expect(normaliseEmail('  A@B.BG ')).toBe('a@b.bg');
    });

    it('are required', async () => {
      await expect(recordBounce({ email: '   ', kind: 'hard' })).rejects.toThrow(/email is required/);
    });
  });

  it('lists what is blocking, and what has been dealt with', async () => {
    const host = await registerHost();
    await recordBounce({ email: host.email, kind: 'hard', detail: '550 no such user', source: 'spec' });

    const active = await listBounces(false);
    const mine = active.find((b) => b.email === host.email.toLowerCase());
    expect(mine?.detail).toBe('550 no such user');
    expect(mine?.clearedAt).toBeNull();

    await clearBounce(host.email);
    expect((await listBounces(false)).map((b) => b.email)).not.toContain(host.email.toLowerCase());
    expect((await listBounces(true)).map((b) => b.email)).toContain(host.email.toLowerCase());
  });
});
