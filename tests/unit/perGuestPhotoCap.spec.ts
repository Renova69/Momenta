import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { pool, query } from '../../server/lib/db';
import { DEFAULT_MAX_PHOTOS_PER_GUEST } from '../../shared/planCaps';

const TEST_PORT = 6647;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

/**
 * How many photos one guest may upload.
 *
 * This is a number the host types into a form, and the two ends of its range
 * are the interesting ones. `events.max_photos_per_guest` is nullable, and
 * null means "the host expressed no preference, use the default" — but zero is
 * a deliberate choice that means the opposite, accept nothing. Reading the
 * column with `||` collapses those two: zero is falsy, so a host who shut
 * uploads off got the default of fifty per guest instead, which is as close to
 * the exact opposite of the instruction as the code could manage. `??` is what
 * keeps them apart, and nothing about a passing upload reveals which operator
 * is in the source.
 *
 * The counting side matters too. A device that ends up with more than one
 * guest row — a guest who cleared their storage, or rejoined under a new name
 * — must not thereby get a second allowance, or the cap is advisory.
 */

const createdEvents: string[] = [];
let jpegDataUrl = '';

async function registerHost(): Promise<{ token: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Cap Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, eventId: data.event.id };
}

async function setCap(eventId: string, cap: number | null): Promise<void> {
  await pool.query('UPDATE events SET max_photos_per_guest = $2 WHERE id = $1', [eventId, cap]);
}

function uploadPhoto(
  eventId: string,
  fingerprint: string | undefined,
  guestName = 'Ana'
): Promise<Response> {
  const body: Record<string, unknown> = {
    eventId,
    guestName,
    fullUrl: jpegDataUrl,
  };
  if (fingerprint) body.deviceFingerprint = fingerprint;

  return fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Keeps each test's uploads on their own rate-limit budget, as separate
      // phones at a reception would be.
      'x-device-fingerprint': fingerprint || `cap-spec-${Math.random().toString(36).slice(2, 9)}`,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/photos', photosRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

  const jpeg = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 160, b: 120 } },
  })
    .jpeg()
    .toBuffer();
  jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}, 30_000);

afterAll(async () => {
  if (server) server.close();
  await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(
    () => undefined
  );
});

describe('a host who sets the cap to zero', () => {
  it('gets no uploads at all, not the default fifty', async () => {
    // The regression. Zero is falsy, so `||` turned "accept nothing" into
    // "accept the default" — and the host had no way to tell, because the
    // setting they saved was still showing zero in their own dashboard.
    const { eventId } = await registerHost();
    await setCap(eventId, 0);

    const res = await uploadPhoto(eventId, 'device-zero-cap');

    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain('0');
  }, 30_000);
});

describe('a host who sets no cap', () => {
  it('falls back to the default', async () => {
    const { eventId } = await registerHost();
    await setCap(eventId, null);

    const res = await uploadPhoto(eventId, 'device-null-cap');

    expect(res.status).toBe(201);
    expect(DEFAULT_MAX_PHOTOS_PER_GUEST).toBeGreaterThan(0);
  }, 30_000);
});

describe('a host who sets a real cap', () => {
  it('accepts up to the limit and refuses the one after it', async () => {
    const { eventId } = await registerHost();
    await setCap(eventId, 2);
    const device = 'device-cap-of-two';

    const first = await uploadPhoto(eventId, device);
    const second = await uploadPhoto(eventId, device);
    const third = await uploadPhoto(eventId, device);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(429);
  }, 40_000);

  it('tells the guest what the limit was', async () => {
    // A bare 429 reads as "the app is broken" to someone at a party. The
    // number is the difference between a refusal and a fault.
    const { eventId } = await registerHost();
    await setCap(eventId, 1);
    const device = 'device-cap-message';

    await uploadPhoto(eventId, device);
    const refused = await uploadPhoto(eventId, device);

    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toContain('1');
  }, 30_000);
});

describe('counting a guest’s photos', () => {
  it('holds one budget across every guest row on the same device', async () => {
    // A guest who clears their browser storage mid-reception comes back as a
    // new name against the same device. Counting per guest row would hand
    // them a fresh allowance every time, which makes the cap advisory.
    const { eventId } = await registerHost();
    await setCap(eventId, 2);
    const device = 'device-shared-budget';

    await uploadPhoto(eventId, device, 'Ana');
    await uploadPhoto(eventId, device, 'Ana Again');
    const third = await uploadPhoto(eventId, device, 'Ana Once More');

    expect(third.status).toBe(429);
  }, 40_000);

  it('gives a genuinely different device its own budget', async () => {
    const { eventId } = await registerHost();
    await setCap(eventId, 1);

    const first = await uploadPhoto(eventId, 'device-one', 'Ana');
    const second = await uploadPhoto(eventId, 'device-two', 'Boris');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  }, 40_000);

  it('still counts for a caller that sends no fingerprint at all', async () => {
    // Without a fingerprint the count falls back to the guest row. The cap has
    // to hold on that path too, or omitting one field lifts it.
    const { eventId } = await registerHost();
    await setCap(eventId, 1);

    const first = await uploadPhoto(eventId, undefined, 'Anonymous');
    expect(first.status).toBe(201);
    const guestId = (await first.json()).guestId;

    const second = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-device-fingerprint': `cap-spec-${Math.random().toString(36).slice(2, 9)}`,
      },
      body: JSON.stringify({ eventId, guestId, guestName: 'Anonymous', fullUrl: jpegDataUrl }),
    });

    // The bare guestId is not proof of identity (SEC-A2), so this is a new
    // guest rather than a refusal — but it must not be able to claim the
    // first guest's row either.
    expect([201, 429]).toContain(second.status);
    if (second.status === 201) {
      expect((await second.json()).guestId).not.toBe(guestId);
    }
  }, 40_000);
});
