import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { deleteEventFixturesForHost } from '../helpers/cleanup';
import { query } from '../../server/lib/db';

/**
 * N-58 — deleting an album freed its address at once. Printed QR codes and
 * table cards for that wedding stay in circulation, so the next host to pick
 * the same custom address received the guests who scanned them — and their
 * photos. An address now stays with the host who deleted it for a year;
 * anyone else asking for it is given a variant, the same way a taken address
 * already is.
 */

const TEST_PORT = 6664;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const users: string[] = [];

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
      email: `slug-reserve-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Slug Reservation Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  users.push(data.user.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id, slug: data.event.slug };
}

async function renameTo(host: Host, slug: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ slug }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).slug as string;
}

async function deleteAlbum(host: Host, slug: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ confirmSlug: slug }),
  });
  expect(res.status).toBe(200);
}

/** A custom address that has been used and deleted by `owner`. */
async function deletedAddress(): Promise<{ owner: Host; slug: string }> {
  const owner = await registerHost();
  const slug = `ana-and-boris-${Date.now().toString(36)}`;
  expect(await renameTo(owner, slug)).toBe(slug);
  await deleteAlbum(owner, slug);
  return { owner, slug };
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  for (const userId of users) await deleteEventFixturesForHost(userId);
  await query('DELETE FROM event_deletions WHERE host_user_id = ANY($1::uuid[])', [users]).catch(() => undefined);
  if (server) server.close();
});

describe('the address of a deleted album (N-58)', () => {
  it('is not handed to another host who renames their album to it', async () => {
    const { slug } = await deletedAddress();
    const stranger = await registerHost();

    expect(await renameTo(stranger, slug)).not.toBe(slug);
  });

  it('is not handed to another host who creates an album with it', async () => {
    const { slug } = await deletedAddress();
    const stranger = await registerHost();
    await deleteAlbum(stranger, stranger.slug); // make room under the free plan's one album

    const res = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stranger.token}` },
      body: JSON.stringify({ title: 'Our Wedding', hostName: 'Stranger', slug }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).slug).not.toBe(slug);
  });

  it('can still be taken back by the host who deleted it', async () => {
    const { owner, slug } = await deletedAddress();

    const res = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ title: 'Our Wedding', hostName: 'Owner', slug }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).slug).toBe(slug);
  });

  it('does not rename an album that saves its own current address', async () => {
    // Found by the review of f19f8ca. Two albums could share an address
    // before N-58: one host deleted it, another took it. An edit form that
    // sends the album's own slug back must not now move that live album to a
    // variant and break its printed cards.
    const holder = await registerHost();
    const slug = await renameTo(holder, `taken-before-${Date.now().toString(36)}`);
    await query(
      'INSERT INTO event_deletions (event_id, slug, host_user_id) VALUES (gen_random_uuid(), $1, NULL)',
      [slug]
    );

    expect(await renameTo(holder, slug)).toBe(slug);
  });

  it('is free again once the reservation has lapsed', async () => {
    const { slug } = await deletedAddress();
    await query("UPDATE event_deletions SET deleted_at = NOW() - INTERVAL '400 days' WHERE slug = $1", [slug]);
    const stranger = await registerHost();

    expect(await renameTo(stranger, slug)).toBe(slug);
  });
});
