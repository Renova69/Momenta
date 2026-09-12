import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { cleanSlug } from '../../server/lib/storage';
import { query } from '../../server/lib/db';

/**
 * Regression for OPEN_ITEMS.md P5 — event creation checked slug uniqueness
 * with a SELECT before the INSERT. Two requests landing in the same window
 * (a registration burst, or two hosts choosing the same URL) could both pass
 * the check and then have the second INSERT fail on `events_slug_key` with
 * an unhandled Postgres error — a 500 instead of a working account.
 *
 * The fix retries the INSERT itself against the real constraint, in both
 * `POST /api/events` (explicit or generated slug) and `POST /api/auth/register`
 * (the auto-created first event).
 */

const TEST_PORT = 6603;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;
const createdEventIds: string[] = [];

async function registerHost(fullName?: string): Promise<{ token: string; eventId: string; slug: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `slug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: fullName || 'Slug Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  if (data.event?.id) createdEventIds.push(data.event.id);
  return { token: data.token, eventId: data.event.id, slug: data.event.slug };
}

describe('Slug collision retry (P5)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    if (createdEventIds.length > 0) {
      await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEventIds]).catch(() => undefined);
    }
    if (server) server.close();
  });

  it('POST /api/events retries with a different slug on a real collision instead of 500ing', async () => {
    const hostA = await registerHost();
    const hostB = await registerHost();
    // Pro Planner-equivalent event limit isn't needed here — each host only
    // creates one extra event, and registration already used their default.
    await query("UPDATE subscriptions SET tier = 'pro_planner', event_limit = 10 WHERE user_id IN (SELECT host_user_id FROM events WHERE id = ANY($1::uuid[]))", [
      [hostA.eventId, hostB.eventId],
    ]);

    const explicitSlug = `collision-spec-${Date.now()}`;

    const resA = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostA.token}` },
      body: JSON.stringify({ hostName: 'Host A', slug: explicitSlug }),
    });
    expect(resA.status).toBe(201);
    const eventA = await resA.json();
    createdEventIds.push(eventA.id);
    expect(eventA.slug).toBe(explicitSlug);

    // Same slug, a different host — the old code would 500 here.
    const resB = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostB.token}` },
      body: JSON.stringify({ hostName: 'Host B', slug: explicitSlug }),
    });
    expect(resB.status).toBe(201);
    const eventB = await resB.json();
    createdEventIds.push(eventB.id);

    expect(eventB.slug).not.toBe(explicitSlug);
    expect(eventB.slug.startsWith(explicitSlug)).toBe(true);
  });

  it('POST /api/auth/register retries the auto-created event on a slug collision', async () => {
    const fullName = 'Collision Registration Host';
    const fixedNow = 1893456000000; // fixed instant, so the generated slug is deterministic
    const expectedSlug = `${cleanSlug(fullName)}-${fixedNow.toString(36)}`;

    // Pre-occupy exactly the slug the first registration attempt will try to
    // generate — same mechanism a real concurrent registration would hit.
    const blocker = await registerHost('Blocker Host');
    await query('UPDATE events SET slug = $1 WHERE id = $2', [expectedSlug, blocker.eventId]);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const res = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `slug-collision-${Math.random().toString(36).slice(2, 7)}@test.com`,
          fullName,
          password: 'Password123!',
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      createdEventIds.push(data.event.id);

      expect(data.event.slug).not.toBe(expectedSlug);
      expect(data.event.slug.startsWith(cleanSlug(fullName))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('creates 10 concurrent events with identical host names with zero failures and unique slugs', async () => {
    const host = await registerHost('Concurrency Host');
    await query("UPDATE subscriptions SET tier = 'pro_planner', event_limit = 20 WHERE user_id = (SELECT host_user_id FROM events WHERE id = $1)", [
      host.eventId,
    ]);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${BASE_URL}/api/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
          body: JSON.stringify({ hostName: 'Concurrent Wedding Host' }),
        })
      )
    );

    const bodies = await Promise.all(results.map((r) => r.json()));
    bodies.forEach((b) => {
      if (b.id) createdEventIds.push(b.id);
    });

    expect(results.every((r) => r.status === 201)).toBe(true);
    const slugs = bodies.map((b) => b.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('PUT /api/events/:id retries on a real slug collision instead of 500ing (DB-12)', async () => {
    const hostA = await registerHost('DB12 Host A');
    const hostB = await registerHost('DB12 Host B');
    createdEventIds.push(hostA.eventId, hostB.eventId);

    const targetSlug = `db12-target-${Date.now()}`;
    const takeSlug = await fetch(`${BASE_URL}/api/events/${hostA.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostA.token}` },
      body: JSON.stringify({ slug: targetSlug }),
    });
    expect(takeSlug.status).toBe(200);
    expect((await takeSlug.json()).slug).toBe(targetSlug);

    // Host B updates onto the same slug host A already holds — the old
    // check-then-adjust code raced a SELECT against the eventual UPDATE;
    // this drives it directly at the real constraint.
    const collideSlug = await fetch(`${BASE_URL}/api/events/${hostB.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostB.token}` },
      body: JSON.stringify({ slug: targetSlug }),
    });
    expect(collideSlug.status).toBe(200);
    const bBody = await collideSlug.json();
    expect(bBody.slug).not.toBe(targetSlug);
    expect(bBody.slug.startsWith(targetSlug)).toBe(true);
  });
});
