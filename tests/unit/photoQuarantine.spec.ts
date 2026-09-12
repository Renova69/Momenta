import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { CONFIG } from '../../server/lib/config';

/**
 * Regression for OPEN_ITEMS.md MED-03/SEC-M5 — a photo pending moderation, or
 * still disposable-locked, used to be saved straight to the publicly-served
 * `/uploads` directory. API-level filtering hid it from the feed and the
 * WebSocket room, but did nothing to stop someone who had, guessed, or
 * leaked the raw file URL directly — `express.static` has no concept of
 * "pending." These tests check the actual filesystem, not just API
 * responses, since that's exactly what the original finding was about.
 */

const TEST_PORT = 6621;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';

interface Session {
  token: string;
  userId: string;
  eventId: string;
}

async function registerHost(): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `quarantine-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Quarantine Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

async function uploadPhoto(eventId: string, caption: string) {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Quarantine Spec Guest',
      deviceFingerprint: `q-fp-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
      caption,
    }),
  });
  return { status: res.status, body: await res.json() };
}

/** The bare `/uploads/...` or `/quarantine/...` filesystem-relative segment. */
function relativeSegment(storagePath: string, prefix: '/uploads/' | '/quarantine/'): string {
  return storagePath.replace(prefix, '');
}

const createdEvents: string[] = [];

describe('Photo quarantine (MED-03/SEC-M5)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 180, g: 140, b: 90 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  it('saves a pending photo outside the publicly-served uploads root entirely', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
    await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isModerationEnabled: true }),
    });

    const uploaded = await uploadPhoto(host.eventId, 'quarantined pending photo');
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.status).toBe('pending');

    const row = await query('SELECT storage_path, original_storage_path, thumbnail_url FROM photos WHERE id = $1', [
      uploaded.body.id,
    ]);
    const { storage_path, thumbnail_url } = row.rows[0];
    expect(storage_path).toMatch(/^\/quarantine\//);

    // The defining property: the file is not reachable at all under the
    // directory express.static actually serves, and really does exist under
    // the quarantine root instead.
    const displaySegment = relativeSegment(storage_path, '/quarantine/');
    expect(fs.existsSync(path.join(CONFIG.UPLOADS_DIR, displaySegment))).toBe(false);
    expect(fs.existsSync(path.join(CONFIG.QUARANTINE_DIR, displaySegment))).toBe(true);

    const thumbPath = thumbnail_url.replace(/^https?:\/\/[^/]+/, '');
    expect(thumbPath).toMatch(/^\/quarantine\//);
  });

  it('refuses a preview request with no token, and one bound to a different photo', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
    await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isModerationEnabled: true }),
    });
    const uploaded = await uploadPhoto(host.eventId, 'needs a real token');

    const noToken = await fetch(`${BASE_URL}/api/photos/${uploaded.body.id}/preview?variant=display`);
    expect(noToken.status).toBe(401);

    const list = await fetch(`${BASE_URL}/api/photos?eventId=${host.eventId}`, {
      headers: { Authorization: `Bearer ${host.token}` },
    });
    const [photo] = await list.json();
    const previewUrl = new URL(photo.fullUrl);
    const stolenToken = previewUrl.searchParams.get('token')!;

    // A second, unrelated photo — the token must not transfer.
    const other = await uploadPhoto(host.eventId, 'a different photo entirely');
    const wrongPhoto = await fetch(
      `${BASE_URL}/api/photos/${other.body.id}/preview?variant=display&token=${stolenToken}`
    );
    expect(wrongPhoto.status).toBe(401);
  });

  it('lets the owning host preview a pending photo via the signed URL GET /api/photos hands back', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
    await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isModerationEnabled: true }),
    });
    await uploadPhoto(host.eventId, 'preview me');

    const list = await fetch(`${BASE_URL}/api/photos?eventId=${host.eventId}`, {
      headers: { Authorization: `Bearer ${host.token}` },
    });
    const [photo] = await list.json();
    expect(photo.fullUrl).toContain('/preview?variant=display&token=');

    const previewRes = await fetch(photo.fullUrl.replace(CONFIG.PUBLIC_BASE_URL, BASE_URL));
    expect(previewRes.status).toBe(200);
    const bytes = Buffer.from(await previewRes.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('does not return a pending photo to a non-host at all (unaffected by quarantine)', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
    await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isModerationEnabled: true }),
    });
    await uploadPhoto(host.eventId, 'guests must not see this');

    const guestList = await fetch(`${BASE_URL}/api/photos?eventId=${host.eventId}`);
    expect(await guestList.json()).toEqual([]);
  });

  it('promotes a photo to the public path on approval, making it a real reachable file', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
    await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isModerationEnabled: true }),
    });
    const uploaded = await uploadPhoto(host.eventId, 'about to be approved');

    const approve = await fetch(`${BASE_URL}/api/photos/${uploaded.body.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(approve.status).toBe(200);

    const row = await query('SELECT storage_path FROM photos WHERE id = $1', [uploaded.body.id]);
    const { storage_path } = row.rows[0];
    expect(storage_path).toMatch(/^\/uploads\//);

    const segment = relativeSegment(storage_path, '/uploads/');
    expect(fs.existsSync(path.join(CONFIG.UPLOADS_DIR, segment))).toBe(true);
    expect(fs.existsSync(path.join(CONFIG.QUARANTINE_DIR, segment))).toBe(false);

    // Now a real guest can just load it directly, same as any other approved photo.
    const guestList = await fetch(`${BASE_URL}/api/photos?eventId=${host.eventId}`);
    const [guestPhoto] = await guestList.json();
    expect(guestPhoto.fullUrl).not.toContain('quarantine');
    expect(guestPhoto.fullUrl).not.toContain('/preview?');
  });

  it('lazily promotes a disposable-locked photo once its reveal deadline passes', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [host.userId]);
    await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        isDisposableMode: true,
        isPublic: false,
        revealAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      }),
    });

    const uploaded = await uploadPhoto(host.eventId, 'hidden until morning, then public');
    expect(uploaded.body.isLocked).toBe(true);

    const beforeReveal = await query('SELECT storage_path FROM photos WHERE id = $1', [uploaded.body.id]);
    expect(beforeReveal.rows[0].storage_path).toMatch(/^\/quarantine\//);

    // Reveal has now passed.
    await query("UPDATE events SET reveal_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [host.eventId]);

    // The read path is what actually notices and promotes it — a guest
    // loading the feed right after the reveal moment, not a cron job.
    const guestList = await fetch(`${BASE_URL}/api/photos?eventId=${host.eventId}`);
    const [guestPhoto] = await guestList.json();
    expect(guestPhoto.fullUrl).not.toContain('quarantine');

    const afterReveal = await query('SELECT storage_path FROM photos WHERE id = $1', [uploaded.body.id]);
    expect(afterReveal.rows[0].storage_path).toMatch(/^\/uploads\//);
    const segment = relativeSegment(afterReveal.rows[0].storage_path, '/uploads/');
    expect(fs.existsSync(path.join(CONFIG.UPLOADS_DIR, segment))).toBe(true);
  });

  it('does not promote a still-locked photo early just because moderation approved it', async () => {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    // Both features on the same event: moderation gates the initial
    // approval; disposable mode should still hold the reveal afterward.
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [host.userId]);
    await fetch(`${BASE_URL}/api/events/${host.eventId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        isModerationEnabled: true,
        isDisposableMode: true,
        isPublic: false,
        revealAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      }),
    });

    const uploaded = await uploadPhoto(host.eventId, 'approved but still locked');
    expect(uploaded.body.status).toBe('pending');
    expect(uploaded.body.isLocked).toBe(true);

    await fetch(`${BASE_URL}/api/photos/${uploaded.body.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ status: 'approved' }),
    });

    const row = await query('SELECT storage_path FROM photos WHERE id = $1', [uploaded.body.id]);
    expect(row.rows[0].storage_path).toMatch(/^\/quarantine\//);
  });
});
