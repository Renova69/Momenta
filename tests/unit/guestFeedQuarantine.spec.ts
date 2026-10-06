import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';

import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { storageAdapter } from '../../server/lib/storage';
import { generateToken } from '../../server/middleware/auth';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-72 — the feed promotes whatever has become eligible before it reads, but
 * that can fail for one photo, or be running on another request, which holds
 * the album's promotion lock. Guests were then sent the approved photo with
 * URLs into quarantine: a broken image under local storage. A photo reaches a
 * guest's feed once all of its files are public, which the next load does.
 */

let baseUrl = '';
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/photos', photosRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function albumWithHost(): Promise<{ eventId: string; guestId: string; token: string }> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await query<{ id: string; email: string }>(
    `INSERT INTO users (email, full_name, password_hash, role)
     VALUES ($1, 'N-72 Host', 'x', 'couple') RETURNING id, email`,
    [`n72-${tag}@test.com`]
  );
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, host_user_id)
     VALUES ($1, 'N-72 Spec', 'Spec Host', $2, CURRENT_DATE, $3) RETURNING id`,
    [`n72-${tag}`, user.rows[0].email, user.rows[0].id]
  );
  createdEvents.push(event.rows[0].id);
  const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'G') RETURNING id`, [
    event.rows[0].id,
  ]);
  const token = generateToken({
    userId: user.rows[0].id,
    email: user.rows[0].email,
    role: 'couple',
    fullName: 'N-72 Host',
    tokenVersion: 0,
  });
  return { eventId: event.rows[0].id, guestId: guest.rows[0].id, token };
}

async function addPhoto(
  eventId: string,
  guestId: string,
  caption: string,
  files: { display: 'public' | 'quarantine'; thumb: 'public' | 'quarantine'; flag: boolean }
): Promise<void> {
  const tag = Math.random().toString(36).slice(2, 8);
  const save = (name: string, where: 'public' | 'quarantine') =>
    storageAdapter.save(Buffer.from(name), `${name}-${tag}.jpg`, 'image/jpeg', eventId, {
      quarantine: where === 'quarantine',
    });
  const display = await save('display', files.display);
  const thumb = await save('thumb', files.thumb);
  await query(
    `INSERT INTO photos (event_id, guest_id, storage_path, full_url, thumbnail_url, caption, status,
                         is_quarantined, storage_bytes)
     VALUES ($1, $2, $3, $3, $4, $5, 'approved', $6, 0)`,
    [eventId, guestId, display.storagePath, thumb.storagePath, caption, files.flag]
  );
}

async function feed(eventId: string, token?: string): Promise<{ caption: string; fullUrl: string }[]> {
  const res = await fetch(`${baseUrl}/api/photos?eventId=${eventId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  expect(res.status).toBe(200);
  return res.json();
}

/** Promotion fails for every photo, as it would during a storage outage. */
function storageRefusesPromotion(): void {
  vi.spyOn(storageAdapter, 'promoteFromQuarantine').mockRejectedValue(new Error('storage down'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('an approved photo whose files are not public yet (N-72)', () => {
  it('is left out of a guest feed rather than sent with links into quarantine', async () => {
    const { eventId, guestId } = await albumWithHost();
    await addPhoto(eventId, guestId, 'public', { display: 'public', thumb: 'public', flag: false });
    await addPhoto(eventId, guestId, 'still quarantined', { display: 'quarantine', thumb: 'quarantine', flag: true });
    storageRefusesPromotion();

    const photos = await feed(eventId);

    expect(photos.map((p) => p.caption)).toEqual(['public']);
    for (const p of photos) expect(p.fullUrl).not.toContain('quarantine');
  });

  it('is left out while only some of its files have been moved', async () => {
    const { eventId, guestId } = await albumWithHost();
    await addPhoto(eventId, guestId, 'half moved', { display: 'public', thumb: 'quarantine', flag: true });
    storageRefusesPromotion();

    const photos = await feed(eventId);

    expect(photos).toHaveLength(0);
  });

  it('is still shown to the host, by preview link', async () => {
    const { eventId, guestId, token } = await albumWithHost();
    await addPhoto(eventId, guestId, 'host sees it', { display: 'quarantine', thumb: 'quarantine', flag: true });
    storageRefusesPromotion();

    const photos = await feed(eventId, token);

    expect(photos.map((p) => p.caption)).toEqual(['host sees it']);
    expect(photos[0].fullUrl).toContain('/preview?variant=display');
  });

  it('reaches the guest feed once its promotion succeeds', async () => {
    const { eventId, guestId } = await albumWithHost();
    await addPhoto(eventId, guestId, 'promoted on load', { display: 'quarantine', thumb: 'quarantine', flag: true });

    const photos = await feed(eventId);

    expect(photos.map((p) => p.caption)).toEqual(['promoted on load']);
    expect(photos[0].fullUrl).not.toContain('quarantine');
  });
});
