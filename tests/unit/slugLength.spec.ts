import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { query } from '../../server/lib/db';
import { generateToken } from '../../server/middleware/auth';
import { cleanSlug, SLUG_MAX_LENGTH } from '../../shared/transliterate';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-87 — an album's address lives in a 100-character column. Validation let
 * a custom one through at up to 120, an address that needed a variant had a
 * suffix appended past the limit, and one generated from a host's name could
 * run past it once a Bulgarian name was transliterated (щ becomes "sht").
 * Each of those failed at the column with a 500.
 */

let baseUrl = '';
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];
const createdUsers: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]).catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function hostWithAlbum(): Promise<{ eventId: string; token: string }> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await query<{ id: string; email: string }>(
    `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'Slug Host', 'x', 'couple') RETURNING id, email`,
    [`slug-${tag}@test.com`]
  );
  await query(
    `INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency, event_limit)
     VALUES ($1, 'celebration_pass', 'active', 'one_time', 0, 'EUR', 1)`,
    [user.rows[0].id]
  );
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, host_user_id)
     VALUES ($1, 'Slug Spec', 'Slug Host', $2, CURRENT_DATE, $3) RETURNING id`,
    [`slug-${tag}`, user.rows[0].email, user.rows[0].id]
  );
  createdEvents.push(event.rows[0].id);
  createdUsers.push(user.rows[0].id);
  const token = generateToken({
    userId: user.rows[0].id,
    email: user.rows[0].email,
    role: 'couple',
    fullName: 'Slug Host',
    tokenVersion: 0,
  });
  return { eventId: event.rows[0].id, token };
}

function setSlug(album: { eventId: string; token: string }, slug: string) {
  return fetch(`${baseUrl}/api/events/${album.eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${album.token}` },
    body: JSON.stringify({ slug }),
  });
}

/** A valid address of exactly `length` characters. */
const addressOf = (length: number, seed = Math.random().toString(36).slice(2, 6)) =>
  `${seed}-${'a'.repeat(length - seed.length - 1)}`;

describe('the length of an album address (N-87)', () => {
  it('matches the column it is stored in', () => {
    expect(SLUG_MAX_LENGTH).toBe(100);
  });

  it('refuses a custom address longer than the column with a 400, not a 500', async () => {
    const album = await hostWithAlbum();

    const res = await setSlug(album, addressOf(101));

    expect(res.status).toBe(400);
  });

  it('accepts a custom address of exactly the column length', async () => {
    const album = await hostWithAlbum();
    const slug = addressOf(100);

    const res = await setSlug(album, slug);

    expect(res.status).toBe(200);
    expect((await res.json()).slug).toBe(slug);
  });

  it('keeps a variant of a taken full-length address within the column', async () => {
    const first = await hostWithAlbum();
    const second = await hostWithAlbum();
    const slug = addressOf(100);
    expect((await setSlug(first, slug)).status).toBe(200);

    const res = await setSlug(second, slug);

    expect(res.status).toBe(200);
    const stored = (await res.json()).slug as string;
    expect(stored).not.toBe(slug);
    expect(stored.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(stored).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('builds an address from the longest Bulgarian name that fits the column', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `slug-long-${Date.now()}@test.com`,
        fullName: 'Щ'.repeat(100),
        password: 'Password123!',
      }),
    });
    const body = await res.json();
    if (body.event?.id) createdEvents.push(body.event.id);
    if (body.user?.id) createdUsers.push(body.user.id);

    expect(res.status).toBe(201);
    expect(String(body.event.slug).length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });

  it('leaves room in a generated address for the suffixes added to it', () => {
    const slug = cleanSlug('Щ'.repeat(100), '2026-09-18');

    // A timestamp and a random part are appended on registration, a variant
    // suffix when the address is taken.
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH - 30);
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});
