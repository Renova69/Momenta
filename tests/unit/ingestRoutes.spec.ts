import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { ingestRouter } from '../../server/routes/ingest';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import sharp from 'sharp';

const TEST_PORT = 6596;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;
let hostToken = '';
let eventId = '';
let otherEventId = '';

/** A real, decodable JPEG - the pipeline resizes it, so a header alone is not enough. */
let JPEG_BYTES: Buffer;

/** Header-only bytes: passes the magic-byte check but cannot be decoded. */
const CORRUPT_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

// Node's fetch accepts a Buffer body at runtime; the DOM lib's BodyInit union
// does not model it, and wrapping it in a Blob changes how multer sees the
// stream. Cast rather than reshape the bytes.
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

/** Same shape as multipart(), but with N copies of the file field for a batch upload. */
function multipartBatch(boundary: string, count: number, bytes: Buffer): BodyInit {
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="frame-${i}.jpg"\r\n` +
          'Content-Type: image/jpeg\r\n\r\n'
      ),
      bytes,
      Buffer.from('\r\n')
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts) as unknown as BodyInit;
}

async function registerHost(): Promise<{ token: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Ingest Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, eventId: data.event.id };
}

describe('Photographer Ingest Routes Spec', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/ingest', ingestRouter);
    app.use('/api/photos', photosRouter);

    JPEG_BYTES = await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 210, g: 180, b: 120 } },
    })
      .jpeg()
      .toBuffer();

    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const primary = await registerHost();
    hostToken = primary.token;
    eventId = primary.eventId;

    const secondary = await registerHost();
    otherEventId = secondary.eventId;
  });

  afterAll(async () => {
    if (server) server.close();
  });

  it('issues a key once, lists it masked, and never returns the plaintext again', async () => {
    const createRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ eventId, label: 'Studio X' }),
    });
    expect(createRes.status).toBe(201);

    const created = await createRes.json();
    expect(created.key).toMatch(/^wmi_/);
    expect(created.label).toBe('Studio X');

    const listRes = await fetch(`${BASE_URL}/api/ingest/keys?eventId=${eventId}`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(listRes.status).toBe(200);

    const listed = await listRes.json();
    expect(listed.length).toBeGreaterThan(0);
    // Only a masked hash prefix is ever readable after creation.
    expect(listed[0].key).toBeUndefined();
    expect(listed[0].masked).toHaveLength(10);
  });

  it('rejects key management by anyone other than the owning host', async () => {
    const anonRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId }),
    });
    expect(anonRes.status).toBe(401);

    // A real host, but not this event's host.
    const wrongOwner = await registerHost();
    const forbiddenRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wrongOwner.token}` },
      body: JSON.stringify({ eventId }),
    });
    expect(forbiddenRes.status).toBe(403);
  });

  it('rejects a malformed eventId with 400 rather than a database error', async () => {
    const res = await fetch(`${BASE_URL}/api/ingest/not-a-uuid/photos`, {
      method: 'POST',
      headers: { 'X-Ingest-Key': 'wmi_whatever' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_UUID');
  });

  it('accepts an upload with a valid key and refuses one without', async () => {
    const keyRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ eventId, label: 'Upload key' }),
    });
    const { key } = await keyRes.json();

    const boundary = `----IngestSpec${Date.now()}`;
    const body = multipart(boundary, 'frame.jpg', JPEG_BYTES);
    const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };

    const noKeyRes = await fetch(`${BASE_URL}/api/ingest/${eventId}/photos`, {
      method: 'POST',
      headers,
      body,
    });
    expect(noKeyRes.status).toBe(401);

    const okRes = await fetch(`${BASE_URL}/api/ingest/${eventId}/photos`, {
      method: 'POST',
      headers: { ...headers, 'X-Ingest-Key': key },
      body: multipart(boundary, 'frame.jpg', JPEG_BYTES),
    });
    expect(okRes.status).toBe(201);

    const uploaded = await okRes.json();
    expect(uploaded.uploaded).toBe(1);
    // Pro frames lead the projector rotation and are attributed, not anonymous.
    expect(uploaded.photos[0].source).toBe('photographer');
    expect(uploaded.photos[0].priority).toBe(10);
    expect(uploaded.photos[0].thumbnailUrl).not.toBe(uploaded.photos[0].fullUrl);
    expect(uploaded.photos[0].originalUrl).toBeTruthy();
  });

  it('caps a single batch at 10 files, rejecting a bigger multipart batch outright (MED-04)', async () => {
    const keyRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ eventId, label: 'Batch cap key' }),
    });
    const { key } = await keyRes.json();

    // Exactly the cap succeeds in full.
    const atCapBoundary = `----IngestAtCap${Date.now()}`;
    const atCapRes = await fetch(`${BASE_URL}/api/ingest/${eventId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${atCapBoundary}`, 'X-Ingest-Key': key },
      body: multipartBatch(atCapBoundary, 10, JPEG_BYTES),
    });
    expect(atCapRes.status).toBe(201);
    expect((await atCapRes.json()).uploaded).toBe(10);

    // One over the cap - multer's own `files` limit rejects the whole
    // request before the handler runs, not a 201 with 11 processed.
    const overCapBoundary = `----IngestOverCap${Date.now()}`;
    const overCapRes = await fetch(`${BASE_URL}/api/ingest/${eventId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${overCapBoundary}`, 'X-Ingest-Key': key },
      body: multipartBatch(overCapBoundary, 11, JPEG_BYTES),
    });
    expect(overCapRes.status).not.toBe(201);
  });

  it('rejects a file that cannot be decoded instead of failing with a 500', async () => {
    const keyRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ eventId }),
    });
    const { key } = await keyRes.json();

    const boundary = `----IngestCorrupt${Date.now()}`;
    const res = await fetch(`${BASE_URL}/api/ingest/${eventId}/photos`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Ingest-Key': key,
      },
      body: multipart(boundary, 'broken.jpg', CORRUPT_JPEG),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).uploaded).toBe(0);
  });

  it('scopes a key to its own event', async () => {
    const keyRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ eventId }),
    });
    const { key } = await keyRes.json();

    const boundary = `----IngestScope${Date.now()}`;
    const res = await fetch(`${BASE_URL}/api/ingest/${otherEventId}/photos`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Ingest-Key': key,
      },
      body: multipart(boundary, 'frame.jpg', JPEG_BYTES),
    });
    expect(res.status).toBe(401);
  });

  it('revokes a key so it stops authenticating', async () => {
    const keyRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ eventId, label: 'Temporary' }),
    });
    const { id, key } = await keyRes.json();

    const revokeRes = await fetch(`${BASE_URL}/api/ingest/keys/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(revokeRes.status).toBe(200);

    const boundary = `----IngestRevoked${Date.now()}`;
    const res = await fetch(`${BASE_URL}/api/ingest/${eventId}/photos`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Ingest-Key': key,
      },
      body: multipart(boundary, 'frame.jpg', JPEG_BYTES),
    });
    expect(res.status).toBe(401);
  });

  it('does not accept an ingest key from the query string', async () => {
    const keyRes = await fetch(`${BASE_URL}/api/ingest/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ eventId }),
    });
    const { key } = await keyRes.json();

    // A key in the URL ends up in access logs and proxy history, so the server
    // only reads it from headers.
    const boundary = `----IngestQuery${Date.now()}`;
    const res = await fetch(
      `${BASE_URL}/api/ingest/${eventId}/photos?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: multipart(boundary, 'frame.jpg', JPEG_BYTES),
      }
    );
    expect(res.status).toBe(401);
  });

  it('cleans up the events created by this spec', async () => {
    const deleted = await query('DELETE FROM events WHERE id = ANY($1::uuid[]) RETURNING id', [
      [eventId, otherEventId],
    ]);
    expect(deleted.rowCount).toBeGreaterThan(0);
  });
});
