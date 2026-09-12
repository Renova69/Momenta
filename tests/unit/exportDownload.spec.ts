import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { audioRouter } from '../../server/routes/audio';
import { query } from '../../server/lib/db';
import { issueDownloadToken, verifyDownloadToken } from '../../server/lib/downloadToken';
import { storageAdapter } from '../../server/lib/storage';

const TEST_PORT = 6594;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;
let hostToken = '';
let userId = '';
let eventId = '';
let otherEventId = '';

async function registerHost() {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `export-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Export Spec Host',
      password: 'Password123!',
    }),
  });
  return res.json();
}

async function uploadPhoto(eventId: string, dataUrl: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Export Spec Guest',
      fullUrl: dataUrl,
      deviceFingerprint: `device-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    }),
  });
  expect(res.status).toBe(201);
}

function buildMultipartAudio(bytes: Buffer, fields: Record<string, string>): { body: BodyInit; contentType: string } {
  const boundary = `----ExportAudioSpec${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
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

describe('ZIP export download links', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/audio', audioRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const reg = await registerHost();
    hostToken = reg.token;
    userId = reg.user.id;
    eventId = reg.event.id;

    const other = await registerHost();
    otherEventId = other.event.id;

    // deluxe_keepsake is >= celebration_pass (server/middleware/tierGate.ts
    // TIER_ORDER), so this one row also covers export-zip's own gate while
    // unlocking the audio upload the MED-01 store-mode test needs.
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [userId]);
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [[eventId, otherEventId]]).catch(
      () => undefined
    );
    if (server) server.close();
  });

  it('mints a download ticket for the owning host', async () => {
    const res = await fetch(`${BASE_URL}/api/events/${eventId}/export-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(res.status).toBe(200);

    const ticket = await res.json();
    expect(ticket.token).toBeTruthy();
    expect(ticket.filename).toMatch(/\.zip$/);
    // Short-lived: the credential travels in a URL, so it must not linger.
    expect(ticket.expiresIn).toBeLessThanOrEqual(300);
  });

  it('refuses to mint a ticket without a session', async () => {
    const res = await fetch(`${BASE_URL}/api/events/${eventId}/export-token`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('streams the archive with a valid ticket and no auth header', async () => {
    const ticketRes = await fetch(`${BASE_URL}/api/events/${eventId}/export-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    const { token } = await ticketRes.json();

    // No Authorization header: this is exactly what an <a href> download sends.
    const res = await fetch(
      `${BASE_URL}/api/events/${eventId}/export-zip?token=${encodeURIComponent(token)}`
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('zip');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('refuses the download with no credential at all', async () => {
    const res = await fetch(`${BASE_URL}/api/events/${eventId}/export-zip`);
    expect(res.status).toBe(401);
  });

  it('stores already-compressed content instead of re-deflating it (MED-01)', async () => {
    // A run of zero bytes is close to incompressible for JPEG/WebM in
    // practice but wildly compressible in the abstract — deflate level 9
    // would crush it to a few hundred bytes, while store mode ships it
    // near-verbatim. That gap is what tells the two code paths apart from
    // outside the response, with no need to hand-parse the zip's internals.
    const zeros = Buffer.alloc(100_000, 0);
    const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    const { body, contentType } = buildMultipartAudio(Buffer.concat([webmHeader, zeros]), {
      eventId,
      durationSeconds: '5',
    });
    const uploadRes = await fetch(`${BASE_URL}/api/audio`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
    expect(uploadRes.status).toBe(201);

    const ticketRes = await fetch(`${BASE_URL}/api/events/${eventId}/export-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    const { token } = await ticketRes.json();

    const zipRes = await fetch(
      `${BASE_URL}/api/events/${eventId}/export-zip?token=${encodeURIComponent(token)}`
    );
    expect(zipRes.status).toBe(200);
    const zipBytes = Buffer.from(await zipRes.arrayBuffer());

    // Deflate-9 on 100KB of zeros lands well under 1KB; store mode stays
    // within a few hundred bytes of the original payload plus zip framing.
    expect(zipBytes.length).toBeGreaterThan(95_000);
  });

  it('aborts the export and stops touching storage once the client disconnects (MED-01)', async () => {
    const photoDataUrl = `data:image/jpeg;base64,${(
      await sharp({
        create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .jpeg()
        .toBuffer()
    ).toString('base64')}`;

    const abortEventReg = await registerHost();
    const abortEventId = abortEventReg.event.id;
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
      abortEventReg.user.id,
    ]);

    const PHOTO_COUNT = 6;
    for (let i = 0; i < PHOTO_COUNT; i++) {
      await uploadPhoto(abortEventId, photoDataUrl);
    }

    // Real storage, just paced — wide enough to abort mid-loop deterministically
    // without racing real network/disk timing.
    const realGetStream = storageAdapter.getStream.bind(storageAdapter);
    const getStreamSpy = vi
      .spyOn(storageAdapter, 'getStream')
      .mockImplementation(async (storagePath: string) => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return realGetStream(storagePath);
      });

    try {
      const ticketRes = await fetch(`${BASE_URL}/api/events/${abortEventId}/export-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${abortEventReg.token}` },
      });
      const { token } = await ticketRes.json();

      const controller = new AbortController();
      const zipUrl = `${BASE_URL}/api/events/${abortEventId}/export-zip?token=${encodeURIComponent(token)}`;
      const res = await fetch(zipUrl, { signal: controller.signal });
      const reader = res.body!.getReader();
      await reader.read(); // proves the server has started streaming at least one entry
      controller.abort();
      await reader.cancel().catch(() => undefined);

      // Long enough that an un-fixed loop (no `aborted` check, no req.on('close'))
      // would have paced through every remaining photo at ~75ms each.
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(getStreamSpy.mock.calls.length).toBeLessThan(PHOTO_COUNT);

      // The server itself must still be responsive — the abort must not have
      // left the handler (or anything it holds) hung.
      const followUp = await fetch(`${BASE_URL}/api/events/${abortEventId}/export-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${abortEventReg.token}` },
      });
      expect(followUp.status).toBe(200);
    } finally {
      getStreamSpy.mockRestore();
      await query('DELETE FROM events WHERE id = $1', [abortEventId]).catch(() => undefined);
    }
  });

  it('refuses a ticket minted for a different event', async () => {
    const { token } = issueDownloadToken(otherEventId, userId);

    const res = await fetch(
      `${BASE_URL}/api/events/${eventId}/export-zip?token=${encodeURIComponent(token)}`
    );
    expect(res.status).toBe(401);
  });

  it('does not accept an ordinary session JWT as a download token', () => {
    // A session token grants far more than one download; the purpose claim keeps
    // the two apart.
    expect(verifyDownloadToken(hostToken, eventId)).toBeNull();
  });

  it('binds a ticket to its event and user', () => {
    const { token } = issueDownloadToken(eventId, userId);

    expect(verifyDownloadToken(token, eventId)).toBe(userId);
    expect(verifyDownloadToken(token, otherEventId)).toBeNull();
    expect(verifyDownloadToken('not-a-token', eventId)).toBeNull();
    expect(verifyDownloadToken(undefined, eventId)).toBeNull();
  });
});
