import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import fs from 'fs';
import { WebSocket } from 'ws';

/**
 * Two regressions found by running the load test, both invisible to the
 * existing suites because neither shows up in a REST response.
 *
 *   Same-origin WebSockets — the upgrade allow-list was checked only against
 *   CORS_ORIGIN, which is written for the split dev setup (Vite on 6500 calling
 *   the API on 6501). In the Docker deployment the SPA is served by this same
 *   process on 6501, so the app's own origin was not on the list and every
 *   socket from the real app was refused with a 403. Browsers always send Origin
 *   on an upgrade, which is why HTTP kept working while the live feed, the
 *   projector wall and reactions all went dead.
 *
 *   Thumbnail purge — purgeEventMedia selected thumbnail_url and then never
 *   deleted it. A purged album left its thumbnails in storage permanently:
 *   unreachable, because nothing referenced them any more, and billed forever
 *   on R2.
 */

const TEST_PORT = 6597;

describe('same-origin WebSocket upgrades', () => {
  let server: ReturnType<typeof createServer>;
  let wsManager: typeof import('../../server/ws/wsServer').wsManager;
  const previousCors = process.env.CORS_ORIGIN;

  beforeAll(async () => {
    // An allow-list that deliberately excludes the port we serve on, which is
    // exactly the shape that broke production.
    process.env.CORS_ORIGIN = 'http://localhost:6500,http://192.168.0.35:6500';
    ({ wsManager } = await import('../../server/ws/wsServer'));

    server = createServer(express());
    wsManager.init(server);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
  });

  afterAll(async () => {
    if (previousCors === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = previousCors;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const connect = (origin?: string) =>
    new Promise<'open' | number>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/`, origin ? { origin } : {});
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode || 0));
      ws.on('error', () => resolve(0));
    });

  it('accepts an upgrade from the origin the server was reached on', async () => {
    expect(await connect(`http://localhost:${TEST_PORT}`)).toBe('open');
  });

  it('accepts an upgrade from a configured origin', async () => {
    expect(await connect('http://localhost:6500')).toBe('open');
  });

  it('rejects an upgrade from an unrelated origin', async () => {
    expect(await connect('http://evil.example')).toBe(403);
  });

  it('accepts a client that sends no Origin at all', async () => {
    expect(await connect()).toBe('open');
  });
});

describe('purgeEventMedia', () => {
  it('deletes the thumbnail alongside the display copy and the original', async () => {
    const { pool } = await import('../../server/lib/db');
    const { storageAdapter } = await import('../../server/lib/storage');
    const { purgeEventMedia } = await import('../../server/lib/retention');
    const { CONFIG } = await import('../../server/lib/config');

    // The assertions below read the filesystem directly, so they are only
    // meaningful on local disk. This used to `return` silently when it wasn't
    // — which meant that from the moment .env switched to r2, this spec
    // reported green while asserting nothing at all. A vacuous pass is worse
    // than a failure: it hides the gap. vitest.config.ts now pins local disk
    // for the whole suite, so a non-local provider here is a broken setup.
    expect(CONFIG.STORAGE_PROVIDER).toBe('local');

    const { rows: eventRows } = await pool.query<{ id: string }>(
      `INSERT INTO events (slug, title, host_name, host_email, event_date)
       VALUES ($1, 'Purge Spec', 'Purge Spec Host', 'purge-spec@test.local', CURRENT_DATE)
       RETURNING id`,
      [`purge-spec-${Date.now()}`]
    );
    const eventId = eventRows[0].id;

    const bytes = Buffer.from('x'.repeat(1024));
    const display = await storageAdapter.save(bytes, 'spec-display.jpg', 'image/jpeg', eventId);
    const original = await storageAdapter.save(bytes, 'spec-original.jpg', 'image/jpeg', eventId);
    const thumb = await storageAdapter.save(bytes, 'spec-thumb.jpg', 'image/jpeg', eventId);

    const onDisk = (storagePath: string) =>
      fs.existsSync(storagePath.replace('/uploads/', `${CONFIG.UPLOADS_DIR}/`));

    expect(onDisk(thumb.storagePath)).toBe(true);

    const { rows: guestRows } = await pool.query<{ id: string }>(
      `INSERT INTO guests (event_id, name) VALUES ($1, 'Purge Spec Guest') RETURNING id`,
      [eventId]
    );

    await pool.query(
      `INSERT INTO photos (event_id, guest_id, full_url, storage_path, original_storage_path, thumbnail_url, storage_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        eventId,
        guestRows[0].id,
        display.publicUrl,
        display.storagePath,
        original.storagePath,
        thumb.publicUrl,
        3072,
      ]
    );

    await purgeEventMedia(eventId);

    expect(onDisk(display.storagePath)).toBe(false);
    expect(onDisk(original.storagePath)).toBe(false);
    // The regression: this stayed true, forever.
    expect(onDisk(thumb.storagePath)).toBe(false);

    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
  });
});

describe('DELETE /api/photos/:id', () => {
  const PORT = 6598;
  let server: ReturnType<typeof createServer>;
  let token = '';
  let eventId = '';

  beforeAll(async () => {
    const { authRouter } = await import('../../server/routes/auth');
    const { photosRouter } = await import('../../server/routes/photos');

    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/photos', photosRouter);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(PORT, resolve));

    const res = await fetch(`http://localhost:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `delete-spec-${Date.now()}@test.local`,
        fullName: 'Delete Spec Host',
        password: 'Password123!',
      }),
    });
    const data = (await res.json()) as { token: string; event: { id: string } };
    token = data.token;
    eventId = data.event.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('removes the original and thumbnail, not just the display copy', async () => {
    const { pool } = await import('../../server/lib/db');
    const { storageAdapter } = await import('../../server/lib/storage');
    const { CONFIG } = await import('../../server/lib/config');

    // Must actually run — see the note on the sibling spec above.
    expect(CONFIG.STORAGE_PROVIDER).toBe('local');

    const bytes = Buffer.from('x'.repeat(1024));
    const display = await storageAdapter.save(bytes, 'del-display.jpg', 'image/jpeg', eventId);
    const original = await storageAdapter.save(bytes, 'del-original.jpg', 'image/jpeg', eventId);
    const thumb = await storageAdapter.save(bytes, 'del-thumb.jpg', 'image/jpeg', eventId);

    const onDisk = (storagePath: string) =>
      fs.existsSync(storagePath.replace('/uploads/', `${CONFIG.UPLOADS_DIR}/`));

    const { rows: guestRows } = await pool.query<{ id: string }>(
      `INSERT INTO guests (event_id, name) VALUES ($1, 'Delete Spec Guest') RETURNING id`,
      [eventId]
    );
    const { rows: photoRows } = await pool.query<{ id: string }>(
      `INSERT INTO photos (event_id, guest_id, full_url, storage_path, original_storage_path, thumbnail_url, storage_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        eventId,
        guestRows[0].id,
        display.publicUrl,
        display.storagePath,
        original.storagePath,
        thumb.publicUrl,
        3072,
      ]
    );

    const res = await fetch(`http://localhost:${PORT}/api/photos/${photoRows[0].id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    expect(onDisk(display.storagePath)).toBe(false);
    // The regression: these two stayed on disk forever, while the event's
    // storage_bytes was decremented as though they had been freed.
    expect(onDisk(original.storagePath)).toBe(false);
    expect(onDisk(thumb.storagePath)).toBe(false);
  });
});
