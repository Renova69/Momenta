import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

/**
 * Deleting one photo: the files go first, and the row only once they are gone.
 *
 * The row is the only record of where the bytes live. Deleting it first means
 * anything that stops the file deletes — a deploy restarting the process, a
 * storage error — strands the bytes with nothing left to name them. Neither
 * orphan sweep can recover those: both match whole abandoned albums and skip
 * every key under a live event. The row's removal has meanwhile told the
 * trigger to credit the bytes back, so the quota reports space that is still
 * occupied. That is the shape of the leak this repository has now paid for
 * several times over.
 */

/** Set per test: make the next storage delete fail. */
let failDeletes = false;
/** The photo whose row the storage mock checks for, set per test. */
let watchedPhotoId = '';
/** Whether that row still existed each time storage was asked to delete a file. */
const rowPresentAtDelete: boolean[] = [];

vi.mock('../../server/lib/storage', async () => {
  const actual = await vi.importActual<typeof import('../../server/lib/storage')>('../../server/lib/storage');
  const { query } = await import('../../server/lib/db');
  return {
    ...actual,
    // A proxy, not a spread: the adapter is a class instance, and spreading
    // one drops every method on its prototype.
    storageAdapter: new Proxy(actual.storageAdapter, {
      get(target, prop, receiver) {
        if (prop === 'delete') {
          return async (storagePath: string) => {
            // By id, not by path: the display copy, the original and the
            // thumbnail are three deletes against one row.
            const { rows } = await query('SELECT 1 FROM photos WHERE id = $1', [watchedPhotoId]);
            rowPresentAtDelete.push(rows.length > 0);
            if (failDeletes) throw new Error('storage refused the delete');
            return target.delete(storagePath);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});

import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

const TEST_PORT = 6672;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

async function newHost(): Promise<{ token: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `del-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Delete Ordering Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, eventId: data.event.id };
}

async function upload(eventId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Deleter',
      deviceFingerprint: `del-fp-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

function deletePhoto(photoId: string, token: string) {
  return fetch(`${BASE_URL}/api/photos/${photoId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

const rowCount = async (photoId: string): Promise<number> =>
  (await query('SELECT 1 FROM photos WHERE id = $1', [photoId])).rows.length;

describe('deleting a photo', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/photos', photosRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 80, b: 120 } } })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    failDeletes = false;
    await deleteEventFixtures(createdEvents);
    if (server) server.close();
  });

  it('removes the files before the row', async () => {
    const host = await newHost();
    const photoId = await upload(host.eventId);
    watchedPhotoId = photoId;
    rowPresentAtDelete.length = 0;

    expect((await deletePhoto(photoId, host.token)).status).toBe(200);

    // Storage was asked while the row was still there to name it.
    expect(rowPresentAtDelete.length).toBeGreaterThan(0);
    expect(rowPresentAtDelete.every(Boolean)).toBe(true);
    expect(await rowCount(photoId)).toBe(0);
  });

  it('keeps the row, and the accounting, when storage refuses', async () => {
    const host = await newHost();
    const photoId = await upload(host.eventId);
    const before = await query<{ storage_bytes: string }>('SELECT storage_bytes FROM events WHERE id = $1', [
      host.eventId,
    ]);

    failDeletes = true;
    const res = await deletePhoto(photoId, host.token);
    failDeletes = false;

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('STORAGE_DELETE_FAILED');
    // The photo is still there, so its bytes are still counted and a retry
    // can still find the files.
    expect(await rowCount(photoId)).toBe(1);
    const after = await query<{ storage_bytes: string }>('SELECT storage_bytes FROM events WHERE id = $1', [
      host.eventId,
    ]);
    expect(after.rows[0].storage_bytes).toBe(before.rows[0].storage_bytes);
  });
});
