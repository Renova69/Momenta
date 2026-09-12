import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { guestsRouter } from '../../server/routes/guests';
import { audioRouter } from '../../server/routes/audio';
import { query } from '../../server/lib/db';

/**
 * Regression for OPEN_ITEMS.md SEC-D1 — the free tier's 50-photo cap was
 * enforced by reading the current count, then inserting, with nothing
 * locking the gap between the two. A burst of concurrent uploads for the
 * same event could all read the same stale count, all pass, and all insert
 * — overshooting the cap by however many landed in the window.
 *
 * The fix wraps the final re-check and the insert in one transaction, with
 * a transaction-scoped advisory lock keyed by eventId acquired first — only
 * one upload for a given event is inside that section at a time.
 */

const TEST_PORT = 6604;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const FREE_TIER_MAX_PHOTOS = 50;

let server: ReturnType<typeof createServer>;
let JPEG_DATA_URL = '';

async function registerHost(): Promise<{ token: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `quota-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Quota Race Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, eventId: data.event.id };
}

describe('Concurrent upload quota enforcement (SEC-D1)', () => {
  let eventId = '';

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/guests', guestsRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    JPEG_DATA_URL = `data:image/jpeg;base64,${(
      await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 50, g: 200, b: 90 } } })
        .jpeg()
        .toBuffer()
    ).toString('base64')}`;

    const host = await registerHost();
    eventId = host.eventId;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (server) server.close();
  });

  it('never lets a concurrent burst exceed the free-tier photo cap', async () => {
    const guestRes = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, name: 'Filler Guest' }),
    });
    const guest = await guestRes.json();

    // Fast-forward to 2 photos short of the cap without going through the
    // full pipeline for each — only the count matters here.
    const remaining = 2;
    const toPreCreate = FREE_TIER_MAX_PHOTOS - remaining;
    const values: string[] = [];
    const params: string[] = [];
    for (let i = 0; i < toPreCreate; i++) {
      values.push(`($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4})`);
      params.push(eventId, guest.id, `/uploads/events/${eventId}/filler-${i}.jpg`, `/uploads/events/${eventId}/filler-${i}.jpg`);
    }
    await query(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url) VALUES ${values.join(', ')}`,
      params
    );

    const before = await query('SELECT COUNT(*)::int AS c FROM photos WHERE event_id = $1', [eventId]);
    expect(before.rows[0].c).toBe(toPreCreate);

    // 5 concurrent uploads chasing 2 remaining slots — a real race, not a
    // simulated one. Each gets its own device fingerprint so none of them
    // collide with each other's own per-guest cap first.
    const concurrency = 5;
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        fetch(`${BASE_URL}/api/photos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventId,
            guestName: `Racer ${i}`,
            fullUrl: JPEG_DATA_URL,
            deviceFingerprint: `racer-${i}-${Date.now()}`,
          }),
        })
      )
    );

    const statuses = results.map((r) => r.status);
    const succeeded = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 403).length;

    expect(succeeded).toBe(remaining);
    expect(rejected).toBe(concurrency - remaining);

    const after = await query('SELECT COUNT(*)::int AS c FROM photos WHERE event_id = $1', [eventId]);
    expect(after.rows[0].c).toBe(FREE_TIER_MAX_PHOTOS);
  });
});

describe('Concurrent audio upload quota enforcement (DB-02)', () => {
  const AUDIO_PORT = 6612;
  const AUDIO_BASE_URL = `http://localhost:${AUDIO_PORT}`;
  let audioServer: ReturnType<typeof createServer>;
  let eventId = '';
  let userId = '';

  function buildMultipartAudio(bytes: Buffer, fields: Record<string, string>): { body: BodyInit; contentType: string } {
    const boundary = `----AudioQuota${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const parts: Buffer[] = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="test.webm"\r\nContent-Type: audio/webm\r\n\r\n`
      ),
      bytes,
      Buffer.from('\r\n'),
    ];
    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    // Node's fetch accepts a Buffer body at runtime; DOM's BodyInit type just doesn't know about it.
    return { body: Buffer.concat(parts) as unknown as BodyInit, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  beforeAll(async () => {
    const app = express();
    audioServer = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/audio', audioRouter);
    await new Promise<void>((resolve) => audioServer.listen(AUDIO_PORT, () => resolve()));

    const res = await fetch(`${AUDIO_BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `audioquota-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
        fullName: 'Audio Quota Race Spec Host',
        password: 'Password123!',
      }),
    });
    const data = await res.json();
    eventId = data.event.id;
    userId = data.user.id;
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [userId]);
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (audioServer) audioServer.close();
  });

  it('never lets a concurrent burst of voice messages exceed the plan storage cap', async () => {
    const ONE_MB = 1024 * 1024;
    const DELUXE_LIMIT = 25 * 1024 * 1024 * 1024;
    // Leave room for exactly 1 of the concurrent 1MB uploads, not more.
    await query('UPDATE events SET storage_bytes = $1 WHERE id = $2', [DELUXE_LIMIT - Math.floor(1.5 * ONE_MB), eventId]);

    // A real WebM magic-byte header, padded to ~1MB so the byte count is
    // large enough to matter against the plan's storage cap.
    const audioBuffer = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(ONE_MB - 4, 0),
    ]);

    const concurrency = 5;
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => {
        const { body, contentType } = buildMultipartAudio(audioBuffer, {
          eventId,
          guestId: `racer-${i}-${Date.now()}`,
          guestName: `Audio Racer ${i}`,
          durationSeconds: '5',
        });
        return fetch(`${AUDIO_BASE_URL}/api/audio`, {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body,
        });
      })
    );

    const statuses = results.map((r) => r.status);
    const succeeded = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 403).length;

    // Without the advisory lock (SEC-D1's pattern, missing here before
    // DB-02), all 5 would have read the same stale ~1.5MB "remaining" and
    // all passed the pre-check, landing ~5MB against a ~1.5MB budget.
    expect(succeeded).toBe(1);
    expect(rejected).toBe(concurrency - 1);

    const finalBytes = await query('SELECT storage_bytes FROM events WHERE id = $1', [eventId]);
    expect(Number(finalBytes.rows[0].storage_bytes)).toBeLessThanOrEqual(DELUXE_LIMIT);
  });
});

describe('Concurrent event creation never exceeds the plan event limit (DB-06)', () => {
  const EVENTS_PORT = 6613;
  const EVENTS_BASE_URL = `http://localhost:${EVENTS_PORT}`;
  let eventsServer: ReturnType<typeof createServer>;
  let userId = '';
  let hostToken = '';
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    const app = express();
    eventsServer = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    await new Promise<void>((resolve) => eventsServer.listen(EVENTS_PORT, () => resolve()));

    const res = await fetch(`${EVENTS_BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `eventquota-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
        fullName: 'Event Limit Race Spec Host',
        password: 'Password123!',
      }),
    });
    const data = await res.json();
    userId = data.user.id;
    hostToken = data.token;
    createdEventIds.push(data.event.id); // registration's auto-created event

    // Pro Planner: event_limit = 10.
    await query("UPDATE subscriptions SET tier = 'pro_planner', event_limit = 10 WHERE user_id = $1", [userId]);
  });

  afterAll(async () => {
    if (createdEventIds.length > 0) {
      await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEventIds]).catch(() => undefined);
    }
    if (eventsServer) eventsServer.close();
  });

  it('never lets a concurrent burst create more events than the plan allows', async () => {
    // 1 event already exists from registration; fast-forward to 8 (2 slots
    // left out of the 10-event cap) without going through the full pipeline.
    const toPreCreate = 7;
    for (let i = 0; i < toPreCreate; i++) {
      const res = await fetch(`${EVENTS_BASE_URL}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ hostName: `Filler ${i}`, slug: `db06-filler-${Date.now()}-${i}` }),
      });
      const ev = await res.json();
      createdEventIds.push(ev.id);
    }

    const before = await query('SELECT COUNT(*)::int AS c FROM events WHERE host_user_id = $1', [userId]);
    expect(before.rows[0].c).toBe(8);

    // 5 concurrent creates chasing 2 remaining slots — a real race.
    const concurrency = 5;
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        fetch(`${EVENTS_BASE_URL}/api/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
          body: JSON.stringify({ hostName: `Racer ${i}`, slug: `db06-racer-${Date.now()}-${i}` }),
        })
      )
    );

    for (const r of results) {
      if (r.status === 201) createdEventIds.push((await r.clone().json()).id);
    }

    const statuses = results.map((r) => r.status);
    const succeeded = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 403).length;

    expect(succeeded).toBe(2);
    expect(rejected).toBe(concurrency - 2);

    const after = await query('SELECT COUNT(*)::int AS c FROM events WHERE host_user_id = $1', [userId]);
    expect(after.rows[0].c).toBe(10);
  });
});
