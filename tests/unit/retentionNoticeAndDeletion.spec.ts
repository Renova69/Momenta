import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { sweepExpiredAlbums, RETENTION_NOTICE_DAYS, GRACE_PERIOD_DAYS } from '../../server/lib/retention';
import { query } from '../../server/lib/db';
import { TEST_EMAIL_DOMAINS } from '../../scripts/purge-test-data';

/**
 * D1 — notice before deletion. D2 — an erasure path that exists at all.
 *
 * D1: the retention sweep deleted a host's photos the moment the album passed
 * its grace period, having told nobody. This app has no mailer, so notice
 * cannot be sent, so enforcement cannot responsibly be enabled — a fact that
 * lived in OPEN_ITEMS.md prose where a flipped environment variable would sail
 * past it. It is now a precondition in the code: an album is not deleted until
 * `retention_notified_at` is set and has aged past the notice period.
 *
 * D2: there was no DELETE handler for an event anywhere, so a host could never
 * remove their album and there was no GDPR Article 17 erasure path for a
 * service holding photographs of identifiable people. The ordering matters and
 * is the thing most easily got wrong: deleting the event row cascades the photo
 * rows away, and with them the only record of which stored objects to remove —
 * so media is purged first, and only then the row.
 */

const TEST_PORT = 6642;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
  slug: string;
}

async function registerHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `retnotice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Retention Notice Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id, slug: data.event.slug };
}

async function uploadPhoto(eventId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Retention Guest',
      deviceFingerprint: `ret-fp-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  return (await res.json()).id as string;
}

/** Push an album well past expiry and the grace period. */
async function makeEligible(eventId: string): Promise<void> {
  await query(
    `UPDATE events SET expires_at = NOW() - INTERVAL '${GRACE_PERIOD_DAYS + 10} days' WHERE id = $1`,
    [eventId]
  );
}

async function photoCount(eventId: string): Promise<number> {
  const r = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM photos WHERE event_id = $1', [eventId]);
  return r.rows[0].n;
}

function deleteEvent(host: Host, body: unknown, token = host.token) {
  return fetch(`${BASE_URL}/api/events/${host.eventId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('retention notice and event deletion (D1, D2)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 160, height: 120, channels: 3, background: { r: 190, g: 160, b: 140 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  describe('D1 — no deletion without notice', () => {
    it('refuses to delete an eligible album that was never notified', async () => {
      const host = await registerHost();
      await uploadPhoto(host.eventId);
      await makeEligible(host.eventId);

      const result = await sweepExpiredAlbums(true);

      expect(result.deleted).not.toContain(host.eventId);
      expect(await photoCount(host.eventId)).toBe(1);
    });

    it('reports it as awaiting notice rather than silently ignoring it', async () => {
      const host = await registerHost();
      await uploadPhoto(host.eventId);
      await makeEligible(host.eventId);

      const result = await sweepExpiredAlbums(false);

      expect(result.awaitingNotice.map((c) => c.eventId)).toContain(host.eventId);
      expect(result.eligible.map((c) => c.eventId)).not.toContain(host.eventId);
    });

    it('still refuses while the notice is too recent to have been acted on', async () => {
      const host = await registerHost();
      await uploadPhoto(host.eventId);
      await makeEligible(host.eventId);
      await query('UPDATE events SET retention_notified_at = NOW() - INTERVAL \'1 day\' WHERE id = $1', [
        host.eventId,
      ]);

      const result = await sweepExpiredAlbums(true);

      expect(result.deleted).not.toContain(host.eventId);
      expect(await photoCount(host.eventId)).toBe(1);
    });

    it('deletes once the notice has aged past the notice period', async () => {
      const host = await registerHost();
      await uploadPhoto(host.eventId);
      await makeEligible(host.eventId);
      await query(
        `UPDATE events SET retention_notified_at = NOW() - INTERVAL '${RETENTION_NOTICE_DAYS + 1} days' WHERE id = $1`,
        [host.eventId]
      );

      const result = await sweepExpiredAlbums(true);

      expect(result.deleted).toContain(host.eventId);
      expect(await photoCount(host.eventId)).toBe(0);
    });

    it('means enabling enforcement today deletes nothing, because nothing sets the column', async () => {
      // The whole point of the guard: no real album has ever been notified, so
      // flipping RETENTION_ENFORCED=true is inert rather than catastrophic.
      //
      // Scoped to non-test albums rather than counting the whole table. Vitest
      // runs spec files in parallel workers, and retentionNotices.spec.ts
      // legitimately stamps the albums it creates — so a global count is a
      // measurement of whichever spec happened to be running alongside this
      // one. It passed for as long as the two specs' timings did not overlap,
      // and started failing the moment one of them grew a few more tests.
      const real = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM events
          WHERE retention_notified_at IS NOT NULL
            AND NOT (host_email LIKE ANY($1::text[]))`,
        [TEST_EMAIL_DOMAINS.map((d) => `%@${d}`)]
      );

      expect(real.rows[0].n).toBe(0);
    });
  });

  describe('D2 — host can delete their event', () => {
    it('requires the slug typed back as confirmation', async () => {
      const host = await registerHost();

      const noBody = await deleteEvent(host, {});
      const wrong = await deleteEvent(host, { confirmSlug: 'not-the-slug' });

      expect(noBody.status).toBe(400);
      expect(wrong.status).toBe(400);
      const still = await query('SELECT 1 FROM events WHERE id = $1', [host.eventId]);
      expect(still.rows).toHaveLength(1);
    });

    it('refuses a host who does not own the event, and an anonymous caller', async () => {
      const owner = await registerHost();
      const stranger = await registerHost();

      expect((await deleteEvent(owner, { confirmSlug: owner.slug }, stranger.token)).status).toBe(403);

      const anon = await fetch(`${BASE_URL}/api/events/${owner.eventId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmSlug: owner.slug }),
      });
      expect(anon.status).toBe(401);

      expect((await query('SELECT 1 FROM events WHERE id = $1', [owner.eventId])).rows).toHaveLength(1);
    });

    it('deletes the event, its photos and its stored media', async () => {
      const host = await registerHost();
      await uploadPhoto(host.eventId);
      await uploadPhoto(host.eventId);
      expect(await photoCount(host.eventId)).toBe(2);

      const res = await deleteEvent(host, { confirmSlug: host.slug });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.photosDeleted).toBe(2);
      expect((await query('SELECT 1 FROM events WHERE id = $1', [host.eventId])).rows).toHaveLength(0);
      expect(await photoCount(host.eventId)).toBe(0);
    });

    it('purges media before the row, so the paths are never lost to the cascade', async () => {
      // Deleting the event row cascades photos away, taking with them the only
      // record of which stored objects belong to it. Purging afterwards would
      // orphan every file permanently.
      const host = await registerHost();
      await uploadPhoto(host.eventId);

      const res = await deleteEvent(host, { confirmSlug: host.slug });
      const body = await res.json();

      expect(res.status).toBe(200);
      // bytesFreed can only be non-zero if the photo rows were still readable
      // when the purge ran.
      expect(body.bytesFreed).toBeGreaterThan(0);
    });

    it('records the deletion without keeping the content', async () => {
      const host = await registerHost();
      await uploadPhoto(host.eventId);
      await deleteEvent(host, { confirmSlug: host.slug });

      const audit = await query<{ slug: string; host_user_id: string; photos_deleted: number }>(
        'SELECT slug, host_user_id, photos_deleted FROM event_deletions WHERE event_id = $1',
        [host.eventId]
      );

      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].slug).toBe(host.slug);
      expect(audit.rows[0].host_user_id).toBe(host.userId);
      expect(audit.rows[0].photos_deleted).toBe(1);
    });

    it('answers 404 for an event that is already gone', async () => {
      const host = await registerHost();
      await deleteEvent(host, { confirmSlug: host.slug });

      const again = await deleteEvent(host, { confirmSlug: host.slug });
      expect(again.status).toBe(404);
    });
  });
});
