import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { questsRouter } from '../../server/routes/quests';
import { ingestRouter } from '../../server/routes/ingest';
import { query } from '../../server/lib/db';

/**
 * The MEDIUM validation and error-code findings from the 2026-09-11 review.
 *
 *   M2  — events.slug was `z.string().min(3).max(120)` with no charset rule
 *         and no cleanSlug() on the update path, unlike every creation path.
 *         The value goes into QR URLs and into a Content-Disposition header.
 *   M8  — a concurrent duplicate registration raced past the check-then-insert
 *         and surfaced the unique violation as a 500 rather than the 409 the
 *         non-racing path returns.
 *   M9  — the ingest key routes never validated eventId as a UUID, so a
 *         malformed one reached Postgres as 22P02 and became a 500.
 *   M12 — CreateQuestSchema bounded neither the strings nor the points value.
 */

const TEST_PORT = 6635;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
  email: string;
}

async function registerHost(): Promise<Host> {
  const email = `validate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Validation Spec Host', password: 'Password123!' }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id, email };
}

function putEvent(eventId: string, token: string, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('input validation and error codes (MEDIUM)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api', questsRouter);
    app.use('/api/ingest', ingestRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  describe('M2 — event slug charset', () => {
    it('rejects a slug carrying characters that cannot appear in a URL or a header', async () => {
      const host = await registerHost();

      for (const slug of [
        'has spaces',
        'quote"injection',
        'newline\r\ninjection',
        'sémi-valid',
        'UPPERCASE',
        '../traversal',
        'trailing-',
      ]) {
        const res = await putEvent(host.eventId, host.token, { slug });
        expect({ slug, status: res.status }).toEqual({ slug, status: 400 });
      }
    });

    it('accepts an ordinary lowercase hyphenated slug', async () => {
      const host = await registerHost();
      const slug = `valid-slug-${Math.random().toString(36).slice(2, 8)}`;

      const res = await putEvent(host.eventId, host.token, { slug });

      expect(res.status).toBe(200);
      expect((await res.json()).slug).toBe(slug);
    });

    it('leaves the stored slug usable as a Content-Disposition filename', async () => {
      const host = await registerHost();
      const stored = await query<{ slug: string }>('SELECT slug FROM events WHERE id = $1', [host.eventId]);
      // Node throws ERR_INVALID_CHAR on a header value containing CR/LF, which
      // is what turns a bad slug into a 500 on the export path.
      expect(stored.rows[0].slug).toMatch(/^[a-z0-9-]+$/);
    });
  });

  describe('M8 — duplicate registration', () => {
    it('answers 409, not 500, when the same email registers twice', async () => {
      const host = await registerHost();

      const again = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: host.email, fullName: 'Duplicate', password: 'Password123!' }),
      });

      expect(again.status).toBe(409);
    });

    it('answers 409 for a race that gets past the pre-check', async () => {
      // Both requests read "email not taken" before either inserts, so one hits
      // the users_email_key unique violation. That has to surface as the same
      // 409 the non-racing path returns, not an opaque 500.
      const email = `race-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
      const body = JSON.stringify({ email, fullName: 'Race Host', password: 'Password123!' });

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          fetch(`${BASE_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
        )
      );
      const statuses = results.map((r) => r.status);

      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 500)).toHaveLength(0);
      expect(statuses.filter((s) => s === 409)).toHaveLength(3);

      const created = await query<{ id: string }>('SELECT id FROM events WHERE host_email = $1', [email]);
      createdEvents.push(...created.rows.map((r) => r.id));
    });
  });

  describe('M9 — ingest key routes reject a malformed eventId', () => {
    it('answers 400 on create, not 500', async () => {
      const host = await registerHost();

      const res = await fetch(`${BASE_URL}/api/ingest/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ eventId: 'definitely-not-a-uuid', label: 'Photographer' }),
      });

      expect(res.status).toBe(400);
    });

    it('answers 400 on list, not 500', async () => {
      const host = await registerHost();

      const res = await fetch(`${BASE_URL}/api/ingest/keys?eventId=definitely-not-a-uuid`, {
        headers: { Authorization: `Bearer ${host.token}` },
      });

      expect(res.status).toBe(400);
    });
  });

  describe('M12 — quest creation bounds', () => {
    async function celebrationHost(): Promise<Host> {
      const host = await registerHost();
      await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1 AND status = 'active'", [
        host.userId,
      ]);
      return host;
    }

    function createQuest(host: Host, body: Record<string, unknown>) {
      return fetch(`${BASE_URL}/api/events/${host.eventId}/quests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ title: 'A quest', ...body }),
      });
    }

    it('rejects an unbounded title, description and icon name', async () => {
      const host = await celebrationHost();

      expect((await createQuest(host, { title: 'x'.repeat(5000) })).status).toBe(400);
      expect((await createQuest(host, { description: 'x'.repeat(5000) })).status).toBe(400);
      expect((await createQuest(host, { iconName: 'x'.repeat(500) })).status).toBe(400);
    });

    it('rejects a negative or absurd points value', async () => {
      const host = await celebrationHost();

      expect((await createQuest(host, { points: -50 })).status).toBe(400);
      expect((await createQuest(host, { points: 10_000_000 })).status).toBe(400);
    });

    it('still accepts an ordinary quest', async () => {
      const host = await celebrationHost();

      const res = await createQuest(host, {
        title: 'Catch the bouquet toss',
        description: 'Be ready when it flies',
        points: 25,
      });

      expect(res.status).toBe(201);
    });
  });
});
