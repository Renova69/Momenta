import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { questsRouter } from '../../server/routes/quests';
import { audioRouter } from '../../server/routes/audio';
import { ingestRouter } from '../../server/routes/ingest';
import { guestsRouter } from '../../server/routes/guests';
import { query } from '../../server/lib/db';
import { storageAdapter } from '../../server/lib/storage';

/**
 * Regressions for the 2026-09-04 security pass (OPEN_ITEMS.md Phase 0):
 *
 *   SEC-A1 — POST /api/photos accepted any string as `fullUrl`, not just a
 *   data: URL. A caller could plant another event's real /uploads/... path as
 *   their own photo's storage_path, then pull those bytes out through their
 *   own export-zip. The guard at photos.ts:320 only fired when the string
 *   *looked* like a data: URL, so anything else sailed through untouched.
 *
 *   SEC-M1 — the in-process photographer ingest endpoint accepted up to 200
 *   files per multipart request at up to 50MB each: 10GB of buffers in
 *   memory for one request, with only a valid ingest key as the bar.
 *
 *   SEC-D3 — guestId lookups for likes, comments, quest completions and audio
 *   guestbook entries checked `WHERE id = $1` with no `event_id` scoping, so
 *   a guest from event B could act as a guest in event A.
 */

const TEST_PORT = 6600;
const BASE_URL = `http://localhost:${TEST_PORT}`;

/**
 * Native fetch/FormData does not reliably survive round-tripping through
 * jsdom's globals in this test environment (busboy/multer see zero parts on
 * the other end), so multipart specs build the wire format by hand instead.
 * Matches the existing pattern in ingestRoutes.spec.ts.
 */
function buildMultipartAudio(bytes: Buffer, fields: Record<string, string>): { body: BodyInit; contentType: string } {
  const boundary = `----AudioSpec${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
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
  // Node's fetch accepts a Buffer body at runtime; DOM's BodyInit type just
  // doesn't know about it (matches the multipart() helper below).
  return { body: Buffer.concat(parts) as unknown as BodyInit, contentType: `multipart/form-data; boundary=${boundary}` };
}

let server: ReturnType<typeof createServer>;
let hostAToken = '';
let userAId = '';
let eventAId = '';
let eventBId = '';

let JPEG_BYTES: Buffer;
let JPEG_DATA_URL = '';

function multipart(boundary: string, filename: string, bytes: Buffer): BodyInit {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: image/jpeg\r\n\r\n'
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]) as unknown as BodyInit;
}

async function registerHost(label: string): Promise<{ token: string; userId: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: `${label} Spec Host`,
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

/** Upload a real photo for `eventId` and return its `guestId` and `guestToken`. */
async function uploadPhoto(
  eventId: string,
  token?: string
): Promise<{ photoId: string; guestId: string; guestToken: string }> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      eventId,
      guestName: 'Real Guest',
      fullUrl: JPEG_DATA_URL,
      deviceFingerprint: `device-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    }),
  });
  expect(res.status).toBe(201);
  const photo = await res.json();
  return { photoId: photo.id, guestId: photo.guestId, guestToken: photo.guestToken };
}

describe('Cross-tenant security regressions (SEC-A1, SEC-M1, SEC-D3)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api', questsRouter);
    app.use('/api/audio', audioRouter);
    app.use('/api/ingest', ingestRouter);
    app.use('/api/guests', guestsRouter);

    JPEG_BYTES = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 180, g: 140, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;

    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const a = await registerHost('cross-a');
    hostAToken = a.token;
    userAId = a.userId;
    eventAId = a.eventId;

    const b = await registerHost('cross-b');
    eventBId = b.eventId;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [[eventAId, eventBId]]).catch(() => undefined);
    if (server) server.close();
  });

  describe('SEC-A1 — photo storage_path injection', () => {
    it('rejects a fullUrl that is not a data: URL', async () => {
      const res = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: eventAId,
          guestName: 'Attacker',
          // A real path shape belonging to event B, planted as the attacker's
          // own event-A photo. Before the fix this was stored verbatim as
          // storage_path and would stream out through event A's export-zip.
          fullUrl: `/uploads/events/${eventBId}/planted.jpg`,
        }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects other non-data schemes (javascript:, http:) the same way', async () => {
      for (const fullUrl of ['javascript:alert(1)', 'http://evil.example/x.jpg', '']) {
        if (fullUrl === '') continue; // empty is caught by min(1) separately
        const res = await fetch(`${BASE_URL}/api/photos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: eventAId, guestName: 'Attacker', fullUrl }),
        });
        expect(res.status).toBe(400);
      }
    });

    it('never creates a photo row from a rejected payload', async () => {
      const before = await (await fetch(`${BASE_URL}/api/photos?eventId=${eventAId}`)).json();

      await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: eventAId,
          guestName: 'Attacker',
          fullUrl: `/uploads/events/${eventBId}/planted-2.jpg`,
        }),
      });

      const after = await (await fetch(`${BASE_URL}/api/photos?eventId=${eventAId}`)).json();
      expect(after.length).toBe(before.length);
    });

    it('still accepts a genuine data: URL photo', async () => {
      const { photoId } = await uploadPhoto(eventAId);
      expect(photoId).toBeTruthy();
    });
  });

  describe('SEC-M1 — ingest batch size cap', () => {
    it('refuses a batch larger than the 20-file cap instead of buffering it all', async () => {
      const keyRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostAToken}` },
        body: JSON.stringify({ eventId: eventAId, label: 'OOM spec key' }),
      });
      const { key } = await keyRes.json();

      const boundary = `----OomSpec${Date.now()}`;
      const parts: Buffer[] = [];
      for (let i = 0; i < 21; i++) {
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f${i}.jpg"\r\n` +
              'Content-Type: image/jpeg\r\n\r\n'
          ),
          JPEG_BYTES,
          Buffer.from('\r\n')
        );
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const res = await fetch(`${BASE_URL}/api/ingest/${eventAId}/photos`, {
        method: 'POST',
        headers: { 'X-Ingest-Key': key, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: body as unknown as BodyInit,
      });

      // Before the fix (files: 200) this request succeeded with 21 files
      // accepted (status 201, uploaded: 21). Multer now rejects it before
      // the route handler ever runs.
      expect(res.status).not.toBe(201);
    });

    it('still accepts a batch within the cap', async () => {
      const keyRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostAToken}` },
        body: JSON.stringify({ eventId: eventAId, label: 'Within-cap key' }),
      });
      const { key } = await keyRes.json();

      const boundary = `----WithinCap${Date.now()}`;
      const body = multipart(boundary, 'frame.jpg', JPEG_BYTES);

      const res = await fetch(`${BASE_URL}/api/ingest/${eventAId}/photos`, {
        method: 'POST',
        headers: { 'X-Ingest-Key': key, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      });

      expect(res.status).toBe(201);
    });
  });

  describe('SEC-D3 — cross-tenant guestId scoping', () => {
    let guestBId = '';
    let photoAId = '';

    beforeAll(async () => {
      const uploadB = await uploadPhoto(eventBId);
      guestBId = uploadB.guestId;
      const uploadA = await uploadPhoto(eventAId);
      photoAId = uploadA.photoId;
    });

    it('rejects a like on an event-A photo using an event-B guestId', async () => {
      const res = await fetch(`${BASE_URL}/api/photos/${photoAId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: guestBId }),
      });
      // No guestToken for event A at all — same rejection whether the id is
      // simply out of scope (SEC-D3) or unproven (SEC-A2); like has no
      // fresh-guest fallback, so this is a hard 401.
      expect(res.status).toBe(401);
    });

    it('rejects a comment on an event-A photo attributed to an event-B guestId', async () => {
      const res = await fetch(`${BASE_URL}/api/photos/${photoAId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: guestBId, commentText: 'cross-tenant comment' }),
      });
      // Rejected as out-of-scope, the handler falls through to minting a
      // fresh event-A guest instead of impersonating the event-B one — so
      // this should succeed, but NOT as guestB.
      if (res.status === 201) {
        const comment = await res.json();
        expect(comment.guestId).not.toBe(guestBId);
      } else {
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
    });

    it('rejects a quest completion attributed to an event-B guestId', async () => {
      const questsRes = await fetch(`${BASE_URL}/api/events/${eventAId}/quests`);
      const quests = await questsRes.json();
      expect(quests.length).toBeGreaterThan(0);
      const questId = quests[0].id;

      const res = await fetch(`${BASE_URL}/api/quests/${questId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: guestBId }),
      });

      // An event-B guestId is never honoured on an event-A quest. This used to
      // fall through to a freshly-minted event-A guest and answer 200; since
      // H8 a caller identifying neither a token nor a device is refused
      // outright, which satisfies the same property more strongly — nothing is
      // recorded at all.
      expect(res.status).toBe(401);

      const completion = await query(
        'SELECT 1 FROM guest_quest_completions WHERE quest_id = $1 AND guest_id = $2',
        [questId, guestBId]
      );
      expect(completion.rows).toHaveLength(0);
    });

    it('rejects an audio guestbook entry attributed to an event-B guestId', async () => {
      await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [userAId]);

      const tinyWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
      const { body, contentType } = buildMultipartAudio(tinyWebm, {
        eventId: eventAId,
        guestId: guestBId,
        durationSeconds: '3',
      });

      const res = await fetch(`${BASE_URL}/api/audio`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      });
      expect(res.status).toBe(201);
      const entry = await res.json();
      expect(entry.guestId).not.toBe(guestBId);

      await query("UPDATE subscriptions SET tier = 'free' WHERE user_id = $1", [userAId]);
    });

    it('still allows a guest to like/comment within their own event', async () => {
      const uploadA2 = await uploadPhoto(eventAId);

      const likeRes = await fetch(`${BASE_URL}/api/photos/${uploadA2.photoId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId: uploadA2.guestId, guestToken: uploadA2.guestToken }),
      });
      expect(likeRes.status).toBe(200);

      const commentRes = await fetch(`${BASE_URL}/api/photos/${uploadA2.photoId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guestId: uploadA2.guestId,
          commentText: 'same-event comment',
          guestToken: uploadA2.guestToken,
        }),
      });
      expect(commentRes.status).toBe(201);
    });
  });

  describe('Fingerprint-only guest resolution never mints a fresh credential (SEC-03)', () => {
    it('POST /api/photos: a second upload with a known fingerprint attributes correctly but gets no guestToken', async () => {
    const fingerprint = `sec03-fp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const first = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: eventAId,
        guestName: 'Fingerprint Guest',
        fullUrl: JPEG_DATA_URL,
        deviceFingerprint: fingerprint,
      }),
    });
    expect(first.status).toBe(201);
    const firstPhoto = await first.json();
    expect(firstPhoto.guestToken).toBeTruthy();

    // A second request with the SAME fingerprint and no token at all — as if
    // someone else had merely obtained the fingerprint value, which is
    // client-generated and sent as a plain, non-secret request field.
    const second = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: eventAId,
        guestName: 'Fingerprint Guest',
        fullUrl: JPEG_DATA_URL,
        deviceFingerprint: fingerprint,
      }),
    });
    expect(second.status).toBe(201);
    const secondPhoto = await second.json();

    // Correctly attributed to the same guest (quota-continuity still works)...
    expect(secondPhoto.guestId).toBe(firstPhoto.guestId);
    // ...but no durable credential handed out for an identity this caller
    // never actually proved ownership of.
    expect(secondPhoto.guestToken).toBeUndefined();
  });

  it('POST /api/guests: re-registering on a known fingerprint updates the row but returns no guestToken', async () => {
    const fingerprint = `sec03-guests-fp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const first = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: eventAId, name: 'First Name', deviceFingerprint: fingerprint }),
    });
    expect(first.status).toBe(201);
    const firstGuest = await first.json();
    expect(firstGuest.guestToken).toBeTruthy();

    const second = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: eventAId, name: 'Renamed By Someone Else', deviceFingerprint: fingerprint }),
    });
    expect(second.status).toBe(201);
    const secondGuest = await second.json();

    expect(secondGuest.id).toBe(firstGuest.id);
    expect(secondGuest.guestToken).toBeUndefined();
  });

  it('GET /api/guests: a pure fingerprint lookup never returns a guestToken', async () => {
    const fingerprint = `sec03-lookup-fp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const created = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: eventAId, name: 'Lookup Guest', deviceFingerprint: fingerprint }),
    });
    const createdGuest = await created.json();
    expect(createdGuest.guestToken).toBeTruthy();

    const lookup = await fetch(
      `${BASE_URL}/api/guests?eventId=${eventAId}&deviceFingerprint=${encodeURIComponent(fingerprint)}`
    );
    expect(lookup.status).toBe(200);
    const found = await lookup.json();
    expect(found.id).toBe(createdGuest.id);
    expect(found.guestToken).toBeUndefined();
  });
  });

  describe('ZIP export never asks the storage adapter for a cross-event path (SEC-04)', () => {
    it('skips a photo row whose storage_path was planted into another event\'s folder', async () => {
      // A real file that genuinely belongs to event B.
      const uploadB = await uploadPhoto(eventBId);
      const foreignPathRes = await query('SELECT storage_path FROM photos WHERE id = $1', [uploadB.photoId]);
      const foreignPath = foreignPathRes.rows[0].storage_path as string;
      expect(foreignPath).toContain(`/events/${eventBId}/`);

      // Plant a photo row on event A whose storage_path points at that real
      // event-B file — the scenario the finding describes: a bug, a bad
      // insert, or a migration artifact, not something reachable through the
      // normal API (SEC-A1 already closed that path).
      const plantedId = await query(
        `INSERT INTO photos (event_id, guest_id, storage_path, full_url, thumbnail_url, status, filter_applied)
         SELECT $1, guest_id, $2, $2, $2, 'approved', 'original' FROM photos WHERE id = $3
         RETURNING id`,
        [eventAId, foreignPath, uploadB.photoId]
      );
      expect(plantedId.rows.length).toBe(1);

      await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [userAId]);

      const getStreamSpy = vi.spyOn(storageAdapter, 'getStream');
      const exportRes = await fetch(`${BASE_URL}/api/events/${eventAId}/export-zip`, {
        headers: { Authorization: `Bearer ${hostAToken}` },
      });
      expect(exportRes.status).toBe(200);
      // Drain the stream so the response actually completes.
      await exportRes.arrayBuffer();

      const calledPaths = getStreamSpy.mock.calls.map((args) => args[0]);
      expect(calledPaths).not.toContain(foreignPath);

      getStreamSpy.mockRestore();
      await query('DELETE FROM photos WHERE id = $1', [plantedId.rows[0].id]);
      await query("UPDATE subscriptions SET tier = 'free' WHERE user_id = $1", [userAId]);
    });
  });

  describe('originalUrl is redacted from the public guest feed (MED-02)', () => {
    it('hides originalUrl from a guest but shows it to the owning host', async () => {
      const createRes = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: eventAId,
          guestName: 'Med02 Guest',
          fullUrl: JPEG_DATA_URL,
          originalUrl: JPEG_DATA_URL,
          deviceFingerprint: `med02-fp-${Date.now()}`,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.originalUrl).toBeTruthy();

      const guestFeed = await fetch(`${BASE_URL}/api/photos?eventId=${eventAId}`);
      const guestPhotos = await guestFeed.json();
      const guestView = guestPhotos.find((p: { id: string }) => p.id === created.id);
      expect(guestView).toBeDefined();
      expect(guestView.originalUrl).toBeNull();

      const hostFeed = await fetch(`${BASE_URL}/api/photos?eventId=${eventAId}`, {
        headers: { Authorization: `Bearer ${hostAToken}` },
      });
      const hostPhotos = await hostFeed.json();
      const hostView = hostPhotos.find((p: { id: string }) => p.id === created.id);
      expect(hostView).toBeDefined();
      expect(hostView.originalUrl).toBeTruthy();

      await query('DELETE FROM photos WHERE id = $1', [created.id]);
    });
  });
});
