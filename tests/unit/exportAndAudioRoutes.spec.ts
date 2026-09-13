import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { audioRouter } from '../../server/routes/audio';
import { query } from '../../server/lib/db';

const TEST_PORT = 6644;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;

/**
 * The ZIP export and the audio guestbook, at the HTTP boundary.
 *
 * Both are tier-gated paid features reached with different credentials, and
 * both have refusal paths that had no coverage. The export is the more
 * interesting of the two: it cannot use an Authorization header at all,
 * because a browser cannot put one on the `<a href>` that streams a
 * multi-gigabyte archive to disk. It uses a short-lived single-purpose token
 * in the query string instead, and that token travelling somewhere a session
 * JWT must never go is precisely why it has to be refused for anything else.
 */

interface Host {
  token: string;
  userId: string;
  eventId: string;
  slug: string;
}

async function registerHost(): Promise<Host> {
  const email = `export-spec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Export Spec Host', password: 'Password123!' }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id, eventId: data.event.id, slug: data.event.slug };
}

/** Put this host on a plan that unlocks the paid features. */
async function setTier(userId: string, tier: string): Promise<void> {
  await query(
    `UPDATE subscriptions SET tier = $2 WHERE user_id = $1 AND status = 'active'`,
    [userId, tier]
  );
}

const createdEvents: string[] = [];

describe('export and audio routes', () => {
  let free: Host;
  let paid: Host;

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/audio', audioRouter);

    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    free = await registerHost();
    paid = await registerHost();
    createdEvents.push(free.eventId, paid.eventId);
    await setTier(paid.userId, 'pro_planner');
  }, 30_000);

  afterAll(async () => {
    if (server) server.close();
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(
      () => undefined
    );
  });

  describe('minting an export ticket', () => {
    it('refuses an unauthenticated caller', async () => {
      const res = await fetch(`${BASE_URL}/api/events/${paid.eventId}/export-token`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('refuses a host whose plan does not include the export', async () => {
      const res = await fetch(`${BASE_URL}/api/events/${free.eventId}/export-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${free.token}` },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('TIER_REQUIRED');
    });

    it('refuses a malformed event id with a 400, not a 500', async () => {
      const res = await fetch(`${BASE_URL}/api/events/not-a-uuid/export-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${paid.token}` },
      });
      expect(res.status).toBe(400);
    });

    it('refuses another host’s album', async () => {
      // free's token against paid's event: the tier gate reads the event, so
      // this must fail on ownership rather than pass on the event's plan.
      const res = await fetch(`${BASE_URL}/api/events/${paid.eventId}/export-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${free.token}` },
      });
      expect([401, 403, 404]).toContain(res.status);
    });

    it('mints a ticket and a filename for an entitled host', async () => {
      const res = await fetch(`${BASE_URL}/api/events/${paid.eventId}/export-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${paid.token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(20);
      expect(String(body.filename)).toMatch(/\.zip$/);
      // The slug is what the print shop and the host recognise the file by.
      expect(String(body.filename)).toContain(paid.slug);
    });
  });

  describe('downloading the archive', () => {
    it('refuses a request with no token at all', async () => {
      const res = await fetch(`${BASE_URL}/api/events/${paid.eventId}/export-zip`);
      expect([401, 403]).toContain(res.status);
    });

    it('refuses a garbage token', async () => {
      const res = await fetch(
        `${BASE_URL}/api/events/${paid.eventId}/export-zip?token=not-a-real-token`
      );
      expect([401, 403]).toContain(res.status);
    });

    it('refuses a session JWT used as a download ticket', async () => {
      // The two are deliberately different purposes. A session token accepted
      // here would mean a credential that lives in proxy logs and browser
      // history could act as a full session.
      const res = await fetch(
        `${BASE_URL}/api/events/${paid.eventId}/export-zip?token=${encodeURIComponent(paid.token)}`
      );
      expect([401, 403]).toContain(res.status);
    });

    it('refuses a ticket minted for a different album', async () => {
      await setTier(free.userId, 'pro_planner');
      const ticketRes = await fetch(`${BASE_URL}/api/events/${free.eventId}/export-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${free.token}` },
      });
      const { token } = await ticketRes.json();

      const res = await fetch(
        `${BASE_URL}/api/events/${paid.eventId}/export-zip?token=${encodeURIComponent(token)}`
      );

      expect([401, 403]).toContain(res.status);
      await setTier(free.userId, 'free');
    });

    it('streams an archive for a valid ticket', async () => {
      const ticketRes = await fetch(`${BASE_URL}/api/events/${paid.eventId}/export-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${paid.token}` },
      });
      const { token } = await ticketRes.json();

      const res = await fetch(
        `${BASE_URL}/api/events/${paid.eventId}/export-zip?token=${encodeURIComponent(token)}`
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('attachment');
      await res.arrayBuffer();
    }, 20_000);
  });

  describe('storage usage', () => {
    it('refuses an unauthenticated caller', async () => {
      const res = await fetch(`${BASE_URL}/api/events/${paid.eventId}/usage`);
      expect(res.status).toBe(401);
    });

    it('reports the plan position for the owner', async () => {
      const res = await fetch(`${BASE_URL}/api/events/${paid.eventId}/usage`, {
        headers: { Authorization: `Bearer ${paid.token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.usedBytes).toBe('number');
      expect(typeof body.limitBytes).toBe('number');
      expect(body.limitBytes).toBeGreaterThan(0);
    });

    it('rejects a malformed event id', async () => {
      const res = await fetch(`${BASE_URL}/api/events/not-a-uuid/usage`, {
        headers: { Authorization: `Bearer ${paid.token}` },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('audio guestbook', () => {
    it('lists nothing for an album with no recordings', async () => {
      const res = await fetch(`${BASE_URL}/api/audio?eventId=${paid.eventId}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });

    it('refuses a listing with no event id', async () => {
      const res = await fetch(`${BASE_URL}/api/audio`);
      expect([400, 404]).toContain(res.status);
    });

    it('refuses a listing for a malformed event id', async () => {
      const res = await fetch(`${BASE_URL}/api/audio?eventId=not-a-uuid`);
      expect([400, 404]).toContain(res.status);
    });

    it('refuses an upload with no file attached', async () => {
      const res = await fetch(`${BASE_URL}/api/audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: paid.eventId }),
      });
      expect([400, 415, 500]).toContain(res.status);
    });
  });
});
