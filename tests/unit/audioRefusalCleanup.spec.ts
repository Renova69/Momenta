import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import fs from 'fs';
import path from 'path';

/**
 * A voice message is saved to storage before the locked re-check that may
 * still refuse it: the album was deleted meanwhile (N-47), or a concurrent
 * upload took the last of the quota. Either refusal returned an error and
 * left the saved recording in storage with no row naming it.
 *
 * The early check outside the lock passes, so the only way to reach the
 * refusal under the lock is to make that re-check — the call that carries a
 * client — answer differently. Everything else runs for real.
 */
const refuseUnderLock = vi.hoisted(() => ({ on: false }));

vi.mock('../../server/middleware/tierGate', async () => {
  const actual = await vi.importActual<typeof import('../../server/middleware/tierGate')>(
    '../../server/middleware/tierGate'
  );
  return {
    ...actual,
    getUploadContext: (eventId: string, fingerprint?: string, client?: unknown) =>
      client && refuseUnderLock.on
        ? Promise.resolve(null)
        : actual.getUploadContext(eventId, fingerprint, client as never),
  };
});

import { authRouter } from '../../server/routes/auth';
import { audioRouter } from '../../server/routes/audio';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';
import { deleteEventFixture } from '../helpers/cleanup';

const TEST_PORT = 6663;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let eventId = '';

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 7)]);

function postAudio(): Promise<Response> {
  const boundary = `----AudioRefusal${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="m.webm"\r\nContent-Type: audio/webm\r\n\r\n`
    ),
    WEBM,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="eventId"\r\n\r\n${eventId}\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return fetch(`${BASE_URL}/api/audio`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'x-device-fingerprint': `audio-refusal-${Date.now()}`,
    },
    body: body as unknown as BodyInit,
  });
}

function savedRecordings(): string[] {
  const dir = path.join(CONFIG.UPLOADS_DIR, 'events', eventId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('audio-message'));
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/audio', audioRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `audio-refusal-${Date.now()}@test.com`,
      fullName: 'Audio Refusal Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  eventId = data.event.id;
  // The guestbook is gated to deluxe_keepsake and above.
  await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [data.user.id]);
});

afterAll(async () => {
  refuseUnderLock.on = false;
  await deleteEventFixture(eventId);
  if (server) server.close();
});

describe('a voice message refused under the upload lock', () => {
  it('leaves no recording behind in storage', async () => {
    refuseUnderLock.on = true;

    const res = await postAudio();

    expect(res.status).toBe(404);
    expect(savedRecordings()).toEqual([]);
  });

  it('is stored as normal when nothing refuses it', async () => {
    refuseUnderLock.on = false;

    const res = await postAudio();

    expect(res.status).toBe(201);
    expect(savedRecordings()).toHaveLength(1);
  });
});
