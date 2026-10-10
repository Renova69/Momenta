import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import express from 'express';

import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { storageAdapter, toStoragePath } from '../../server/lib/storage';
import { promotePhotoFromQuarantine } from '../../server/lib/photoQuarantine';
import { generateToken } from '../../server/middleware/auth';
import { CONFIG } from '../../server/lib/config';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-85 — deleting one photo read its file paths with no lock. A promotion
 * moving those files at the same moment left the delete removing the old
 * paths while the row went, so the copies the promotion had just made public
 * stayed in storage with nothing naming them. And when one of the three
 * deletes failed, the row stayed approved with some of its files gone: a
 * broken photo in every guest's feed until the host tried again.
 */

let baseUrl = '';
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/photos', photosRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Album {
  eventId: string;
  token: string;
  photoId: string;
}

/** An album, its host's session, and one approved photo with three files. */
async function albumWithPhoto(options: { quarantined: boolean }): Promise<Album> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await query<{ id: string; email: string }>(
    `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'Delete Host', 'x', 'couple') RETURNING id, email`,
    [`delete-${tag}@test.com`]
  );
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, host_user_id)
     VALUES ($1, 'Delete Spec', 'Spec Host', $2, CURRENT_DATE, $3) RETURNING id`,
    [`delete-${tag}`, user.rows[0].email, user.rows[0].id]
  );
  const eventId = event.rows[0].id;
  createdEvents.push(eventId);
  const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'G') RETURNING id`, [
    eventId,
  ]);
  const [display, original, thumb] = await Promise.all(
    ['display', 'original', 'thumb'].map((v) =>
      storageAdapter.save(Buffer.from(v), `${v}-${tag}.jpg`, 'image/jpeg', eventId, { quarantine: options.quarantined })
    )
  );
  const photo = await query<{ id: string }>(
    `INSERT INTO photos (event_id, guest_id, storage_path, full_url, original_storage_path, original_url,
                         thumbnail_url, status, is_quarantined, storage_bytes)
     VALUES ($1, $2, $3, $3, $4, $4, $5, 'approved', $6, 0) RETURNING id`,
    [eventId, guest.rows[0].id, display.storagePath, original.storagePath, thumb.storagePath, options.quarantined]
  );
  const token = generateToken({
    userId: user.rows[0].id,
    email: user.rows[0].email,
    role: 'couple',
    fullName: 'Delete Host',
    tokenVersion: 0,
  });
  return { eventId, token, photoId: photo.rows[0].id };
}

const deletePhoto = (album: Album) =>
  fetch(`${baseUrl}/api/photos/${album.photoId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${album.token}` },
  });

/** Every file this album holds on disk, under either root. */
function filesOnDisk(eventId: string): string[] {
  const found: string[] = [];
  for (const root of [CONFIG.UPLOADS_DIR, CONFIG.QUARANTINE_DIR]) {
    const dir = path.join(root, 'events', eventId.toLowerCase());
    if (fs.existsSync(dir)) found.push(...fs.readdirSync(dir));
  }
  return found;
}

async function rowOf(photoId: string): Promise<{ status: string } | undefined> {
  const { rows } = await query<{ status: string }>('SELECT status FROM photos WHERE id = $1', [photoId]);
  return rows[0];
}

describe('deleting a photo while its approval is still moving its files (N-85)', () => {
  it('leaves no file behind once the photo is gone', async () => {
    const album = await albumWithPhoto({ quarantined: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = storageAdapter.promoteFromQuarantine.bind(storageAdapter);
    let first = true;
    vi.spyOn(storageAdapter, 'promoteFromQuarantine').mockImplementation(async (p: string) => {
      if (first) {
        first = false;
        await gate;
      }
      return real(p);
    });

    const promotion = promotePhotoFromQuarantine(album.photoId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const deletion = deletePhoto(album);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const [, res] = await Promise.all([promotion, deletion]);

    expect(res.status).toBe(200);
    expect(await rowOf(album.photoId)).toBeUndefined();
    expect(filesOnDisk(album.eventId)).toEqual([]);
  });
});

describe('deleting a photo when storage refuses one of its files (N-85)', () => {
  it('takes it out of the guest feed rather than leave it broken there', async () => {
    const album = await albumWithPhoto({ quarantined: false });
    const real = storageAdapter.delete.bind(storageAdapter);
    vi.spyOn(storageAdapter, 'delete').mockImplementation(async (p: string) => {
      if (p.includes('/thumb-')) throw new Error('storage unavailable');
      return real(p);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await deletePhoto(album);

    expect(res.status).toBe(502);
    expect((await rowOf(album.photoId))?.status).toBe('rejected');
    const feed = await fetch(`${baseUrl}/api/photos?eventId=${album.eventId}`);
    expect(await feed.json()).toEqual([]);
  });

  it('finishes the deletion when the host tries again', async () => {
    const album = await albumWithPhoto({ quarantined: false });
    const real = storageAdapter.delete.bind(storageAdapter);
    const refuse = vi.spyOn(storageAdapter, 'delete').mockImplementation(async (p: string) => {
      if (p.includes('/thumb-')) throw new Error('storage unavailable');
      return real(p);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await deletePhoto(album)).status).toBe(502);
    refuse.mockRestore();

    const retry = await deletePhoto(album);

    expect(retry.status).toBe(200);
    expect(await rowOf(album.photoId)).toBeUndefined();
    expect(filesOnDisk(album.eventId)).toEqual([]);
  });
});

describe('fixtures', () => {
  it('can see the files a photo is stored as', async () => {
    const album = await albumWithPhoto({ quarantined: false });
    expect(filesOnDisk(album.eventId)).toHaveLength(3);
    const { rows } = await query<{ thumbnail_url: string }>('SELECT thumbnail_url FROM photos WHERE id = $1', [
      album.photoId,
    ]);
    expect(toStoragePath(rows[0].thumbnail_url)).toMatch(/^\/uploads\//);
  });
});
