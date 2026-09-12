import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { getStorageUsage, checkPhotoUploadTierLimit } from '../../server/middleware/tierGate';
import { computeExpiry } from '../../server/lib/retention';
import { limitsFor, formatBytes, PLAN_LIMITS } from '../../server/lib/planLimits';

const TEST_PORT = 6595;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;
let hostToken = '';
let userId = '';
let eventId = '';
let photoDataUrl = '';

describe('Storage accounting, quotas and retention', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const reg = await (
      await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `quota-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
          fullName: 'Quota Spec Host',
          password: 'Password123!',
        }),
      })
    ).json();

    hostToken = reg.token;
    userId = reg.user.id;
    eventId = reg.event.id;

    const jpeg = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 160, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    photoDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => undefined);
    if (server) server.close();
  });

  it('starts a new album at zero bytes against its plan allowance', async () => {
    const usage = await getStorageUsage(eventId);
    expect(usage).not.toBeNull();
    expect(usage!.tier).toBe('free');
    expect(usage!.usedBytes).toBe(0);
    expect(usage!.limitBytes).toBe(PLAN_LIMITS.free.storageBytes);
    expect(usage!.maxPhotos).toBe(50);
  });

  it('charges an uploaded photo against the event total', async () => {
    const res = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        guestName: 'Quota Guest',
        deviceFingerprint: `quota-fp-${Date.now()}`,
        fullUrl: photoDataUrl,
        originalUrl: photoDataUrl,
      }),
    });
    expect(res.status).toBe(201);

    // The running total is maintained by trigger, so it reflects the write immediately.
    const usage = await getStorageUsage(eventId);
    expect(usage!.usedBytes).toBeGreaterThan(0);
    expect(usage!.photoCount).toBe(1);

    const { rows } = await query('SELECT storage_bytes FROM photos WHERE event_id = $1', [eventId]);
    // Display copy + thumbnail + original all count toward the allowance.
    expect(Number(rows[0].storage_bytes)).toBeGreaterThan(0);
    expect(Number(rows[0].storage_bytes)).toBe(usage!.usedBytes);
  });

  it('releases the bytes again when a photo is deleted', async () => {
    const before = (await getStorageUsage(eventId))!.usedBytes;
    expect(before).toBeGreaterThan(0);

    const { rows } = await query('SELECT id FROM photos WHERE event_id = $1 LIMIT 1', [eventId]);
    const res = await fetch(`${BASE_URL}/api/photos/${rows[0].id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(res.status).toBe(200);

    expect((await getStorageUsage(eventId))!.usedBytes).toBe(0);
  });

  it('refuses an upload that would exceed the plan allowance', async () => {
    const limit = PLAN_LIMITS.free.storageBytes;

    const withinLimit = await checkPhotoUploadTierLimit(eventId, 1024);
    expect(withinLimit.allowed).toBe(true);

    // One byte over is over.
    const overLimit = await checkPhotoUploadTierLimit(eventId, limit + 1);
    expect(overLimit.allowed).toBe(false);
    expect(overLimit.code).toBe('STORAGE_LIMIT_REACHED');
    expect(overLimit.reason).toContain('512 MB');
  });

  it('reports usage to the owning host and refuses everyone else', async () => {
    const res = await fetch(`${BASE_URL}/api/events/${eventId}/usage`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(res.status).toBe(200);

    const usage = await res.json();
    expect(usage.tier).toBe('free');
    expect(usage.limitLabel).toBe('512 MB');
    expect(usage.percentUsed).toBeGreaterThanOrEqual(0);

    const anon = await fetch(`${BASE_URL}/api/events/${eventId}/usage`);
    expect(anon.status).toBe(401);
  });

  it('pools the allowance across events on Pro Planner only', async () => {
    expect(limitsFor('free').pooled).toBe(false);
    expect(limitsFor('celebration_pass').pooled).toBe(false);
    expect(limitsFor('pro_planner').pooled).toBe(true);

    await query("UPDATE subscriptions SET tier = 'pro_planner' WHERE user_id = $1", [userId]);
    const pooled = await getStorageUsage(eventId);
    expect(pooled!.tier).toBe('pro_planner');
    expect(pooled!.pooled).toBe(true);
    expect(pooled!.maxPhotos).toBeNull();

    await query("UPDATE subscriptions SET tier = 'free' WHERE user_id = $1", [userId]);
  });

  it('starts the retention window at the celebration, not the setup date', () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    const eventDate = '2026-09-18T16:30:00.000Z';

    // A couple who set the album up in January must not lose their archive in January.
    const expiry = computeExpiry('celebration_pass', eventDate, createdAt);
    expect(expiry).not.toBeNull();
    expect(expiry!.getTime()).toBeGreaterThan(new Date(eventDate).getTime());

    const days = (expiry!.getTime() - new Date(eventDate).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });

  it('falls back to the creation date when no event date is set', () => {
    const createdAt = '2026-05-05T00:00:00.000Z';
    const expiry = computeExpiry('free', null, createdAt);
    const days = (expiry!.getTime() - new Date(createdAt).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
  });

  it('keeps Pro Planner albums indefinitely', () => {
    expect(computeExpiry('pro_planner', '2026-09-18T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBeNull();
  });

  it('formats sizes the way the dashboard shows them', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatBytes(10 * 1024 * 1024 * 1024)).toBe('10 GB');
    expect(formatBytes(25 * 1024 * 1024 * 1024)).toBe('25 GB');
  });
});
