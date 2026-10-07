import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { Readable } from 'stream';
import express from 'express';

import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { storageAdapter } from '../../server/lib/storage';
import { issuePreviewToken } from '../../server/lib/previewToken';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-79 — a host previews a photo awaiting moderation through a stream from
 * storage, piped to the response with no error handler and left open when the
 * browser went away. A storage error part way through was an unhandled
 * 'error' event, which takes the whole process down; a host scrolling past
 * the moderation queue left an R2 socket or file handle open per image.
 */

let baseUrl = '';
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

beforeAll(async () => {
  const app = express();
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

/** A pending photo and a preview link its host could open. */
async function previewLink(): Promise<string> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'Preview Host', 'x', 'couple') RETURNING id`,
    [`preview-${tag}@test.com`]
  );
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, host_user_id)
     VALUES ($1, 'Preview Spec', 'Spec Host', 'preview@test.local', CURRENT_DATE, $2) RETURNING id`,
    [`preview-${tag}`, user.rows[0].id]
  );
  createdEvents.push(event.rows[0].id);
  const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'G') RETURNING id`, [
    event.rows[0].id,
  ]);
  const photo = await query<{ id: string }>(
    `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, is_quarantined, storage_bytes)
     VALUES ($1, $2, '/quarantine/events/x/p.jpg', '/quarantine/events/x/p.jpg', 'pending', true, 0) RETURNING id`,
    [event.rows[0].id, guest.rows[0].id]
  );
  const photoId = photo.rows[0].id;
  const token = issuePreviewToken(photoId, user.rows[0].id);
  return `${baseUrl}/api/photos/${photoId}/preview?variant=display&token=${encodeURIComponent(token)}`;
}

/** A storage stream that sends `chunks`, then fails or stays open as told. */
function storageStream(chunks: number, then: 'fail' | 'hang'): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent < chunks) {
        sent += 1;
        this.push(Buffer.alloc(16 * 1024, 1));
        return;
      }
      if (then === 'fail') this.destroy(new Error('R2 connection reset'));
      // 'hang': push nothing more, as a slow object store would.
    },
  });
}

describe('previewing a photo awaiting moderation (N-79)', () => {
  it('answers 500 when storage fails before sending anything, and keeps serving', async () => {
    vi.spyOn(storageAdapter, 'getStream').mockResolvedValue(storageStream(0, 'fail'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const link = await previewLink();

    const res = await fetch(link);

    expect(res.status).toBe(500);
    // The process is still up and answering.
    vi.spyOn(storageAdapter, 'getStream').mockResolvedValue(Readable.from([Buffer.from('ok')]));
    const next = await fetch(link);
    expect(next.status).toBe(200);
    expect(await next.text()).toBe('ok');
  });

  it('cuts the response off when storage fails part way through, and keeps serving', async () => {
    vi.spyOn(storageAdapter, 'getStream').mockResolvedValue(storageStream(2, 'fail'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const link = await previewLink();

    const res = await fetch(link);
    // The headers went out with the first bytes; what is left is a body that
    // does not complete.
    await expect(res.arrayBuffer()).rejects.toThrow();

    vi.spyOn(storageAdapter, 'getStream').mockResolvedValue(Readable.from([Buffer.from('ok')]));
    const next = await fetch(link);
    expect(await next.text()).toBe('ok');
  });

  it('closes the storage stream when the browser goes away', async () => {
    const source = storageStream(1, 'hang');
    vi.spyOn(storageAdapter, 'getStream').mockResolvedValue(source);
    const link = await previewLink();
    const controller = new AbortController();

    const res = await fetch(link, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();

    await vi.waitFor(() => expect(source.destroyed).toBe(true), { timeout: 3000 });
  });
});
