import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import sharp from 'sharp';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { questsRouter } from '../../server/routes/quests';
import { audioRouter } from '../../server/routes/audio';
import { guestsRouter } from '../../server/routes/guests';
import { cleanSlug } from '../../server/lib/storage';
import { query } from '../../server/lib/db';

const TEST_PORT = 6599;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

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
  // Node's fetch accepts a Buffer body at runtime; DOM's BodyInit type just doesn't know about it.
  return { body: Buffer.concat(parts) as unknown as BodyInit, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('Express REST Routes Spec', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(cors());
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/quests', questsRouter);
    app.use('/api', questsRouter);
    app.use('/api/audio', audioRouter);
    app.use('/api/guests', guestsRouter);

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    if (server) server.close();
  });

  it('runs complete lifecycle: auth, event provisioning, guest onboarding, photos, and quests', async () => {
    const email = `spec-${Date.now()}@test.com`;
    const password = 'Password123!';

    // 0. Database query wrapper test
    const dbTest = await query('SELECT 1 as test_num');
    expect(dbTest.rows[0].test_num).toBe(1);

    // 1. Register
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName: 'Spec Couple', password, role: 'couple' }),
    });
    const regData = await regRes.json();
    expect(regRes.status).toBe(201);
    expect(regData.token).toBeDefined();

    const hostToken = regData.token;
    const event = regData.event;

    // 2. Duplicate registration check (409 Conflict)
    const dupRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName: 'Duplicate Couple', password, role: 'couple' }),
    });
    expect(dupRes.status).toBe(409);

    // 3. Login success & failures
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(loginRes.status).toBe(200);

    const wrongPassRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'WrongPassword!' }),
    });
    expect(wrongPassRes.status).toBe(401);

    const notFoundLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nonexistent@test.com', password }),
    });
    expect(notFoundLoginRes.status).toBe(401);

    // 4. GET /api/auth/me
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(meRes.status).toBe(200);

    // 5. Event updates, slug lookup, and 404 on unknown slug
    const eventDetailsRes = await fetch(`${BASE_URL}/api/events/${event.id}`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(eventDetailsRes.status).toBe(200);

    const missingEventDetails = await fetch(`${BASE_URL}/api/events/99999999-9999-9999-9999-999999999999`);
    expect(missingEventDetails.status).toBe(404);

    const publicSlugRes = await fetch(`${BASE_URL}/api/events/slug/${encodeURIComponent(event.slug)}`);
    expect(publicSlugRes.status).toBe(200);

    const unknownSlugRes = await fetch(`${BASE_URL}/api/events/slug/non-existent-wedding-slug`);
    expect(unknownSlugRes.status).toBe(404);

    // Ungated settings are editable on any plan.
    const updateRes = await fetch(`${BASE_URL}/api/events/${event.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ venueName: 'Spec Castle' }),
    });
    expect(updateRes.status).toBe(200);

    // Paid settings are refused server-side on the free plan, not merely hidden
    // in the UI. A fresh registration is always on the free tier.
    const gatedUpdateRes = await fetch(`${BASE_URL}/api/events/${event.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ isModerationEnabled: true }),
    });
    expect(gatedUpdateRes.status).toBe(403);
    expect((await gatedUpdateRes.json()).code).toBe('TIER_REQUIRED');

    const gatedThemeRes = await fetch(`${BASE_URL}/api/events/${event.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ themePalette: 'noir_luxe' }),
    });
    expect(gatedThemeRes.status).toBe(403);

    const updateMissingRes = await fetch(`${BASE_URL}/api/events/99999999-9999-9999-9999-999999999999`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ venueName: 'Ghost Castle' }),
    });
    expect(updateMissingRes.status).toBe(404);

    // QR Canvas Config
    const qrGet = await fetch(`${BASE_URL}/api/events/${event.id}/qr-config`);
    expect(qrGet.status).toBe(200);

    // The QR print studio is a Celebration Pass feature, so a free-tier host is
    // refused here too.
    const qrPut = await fetch(`${BASE_URL}/api/events/${event.id}/qr-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ headline: 'Updated QR Headline' }),
    });
    expect(qrPut.status).toBe(403);

    // 6. Guest onboarding (with & without fingerprint) and lookups
    const deviceFp = `fp-${Date.now()}`;
    const guestRes = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: event.id, name: 'Spec Guest', tableNumber: 'Table 1', deviceFingerprint: deviceFp }),
    });
    const guestData = await guestRes.json();
    expect(guestRes.status).toBe(201);
    const guestId = guestData.id;
    const guestToken = guestData.guestToken;

    // Anonymous guest without fingerprint
    const anonGuestRes = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: event.id, name: 'Anonymous Guest' }),
    });
    expect(anonGuestRes.status).toBe(201);

    const guestLookup = await fetch(`${BASE_URL}/api/guests?eventId=${event.id}&deviceFingerprint=${deviceFp}`);
    expect(guestLookup.status).toBe(200);

    const guestLookupNotFound = await fetch(`${BASE_URL}/api/guests?eventId=${event.id}&deviceFingerprint=non-existent-fp`);
    expect(guestLookupNotFound.status).toBe(404);

    const guestLookupMissing = await fetch(`${BASE_URL}/api/guests`);
    expect(guestLookupMissing.status).toBe(400);

    // Upgrade this host to Celebration Pass so the rest of the lifecycle can
    // exercise the paid surfaces. Entitlement lives in `subscriptions`, which is
    // the only thing the tier gates trust.
    await query(
      "UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1 AND status = 'active'",
      [regData.user.id]
    );

    const qrPutUpgraded = await fetch(`${BASE_URL}/api/events/${event.id}/qr-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ headline: 'Updated QR Headline' }),
    });
    expect(qrPutUpgraded.status).toBe(200);

    const moderationUpgraded = await fetch(`${BASE_URL}/api/events/${event.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ isModerationEnabled: false }),
    });
    expect(moderationUpgraded.status).toBe(200);

    // 7. /api/photos/upload/raw was removed (SEC-02) — it wrote to storage
    // with no photos/audio row, so it was permanently invisible to quota
    // accounting. Confirm it's actually gone, not just unused.
    const removedRawUploadRes = await fetch(`${BASE_URL}/api/photos/upload/raw`, { method: 'POST' });
    expect(removedRawUploadRes.status).toBe(404);

    // 8. Quests creation & listing
    const newQuestRes = await fetch(`${BASE_URL}/api/events/${event.id}/quests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ title: 'Spec Quest', description: 'Take a fun selfie', points: 15 }),
    });
    const newQuest = await newQuestRes.json();
    expect(newQuestRes.status).toBe(201);

    // 9. Photo creation with filter & quest linking, status moderation, like toggle, comments
    // A real, decodable JPEG — buildDerivatives runs sharp on it now (SEC-M4),
    // so header-only magic bytes are no longer enough to pass this endpoint.
    const decodableJpeg = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 180, g: 140, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const photoRes = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: event.id,
        guestId,
        guestToken,
        guestName: 'Spec Guest',
        // Must be a data: URL (SEC-A1) — an external/already-stored path is no
        // longer accepted, since that was exactly the storage_path injection.
        fullUrl: `data:image/jpeg;base64,${decodableJpeg.toString('base64')}`,
        caption: 'Spec Photo',
        filterApplied: 'vintage_warmth',
        questId: newQuest.id,
      }),
    });
    const photoData = await photoRes.json();
    expect(photoRes.status).toBe(201);
    const photoId = photoData.id;

    // Approve & Feature photo in moderation
    const statusRes = await fetch(`${BASE_URL}/api/photos/${photoId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ status: 'featured' }),
    });
    expect(statusRes.status).toBe(200);

    // Photo like (Like then Unlike toggle)
    const likeRes = await fetch(`${BASE_URL}/api/photos/${photoId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, guestToken }),
    });
    expect(likeRes.status).toBe(200);

    const unlikeRes = await fetch(`${BASE_URL}/api/photos/${photoId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, guestToken }),
    });
    expect(unlikeRes.status).toBe(200);

    const commentRes = await fetch(`${BASE_URL}/api/photos/${photoId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Carries the token the upload handed back, exactly as the real client
      // does — the like/unlike calls above already do. Since H8 a comment must
      // identify either a token or a device; it no longer mints a guest row
      // for a caller that identifies neither.
      body: JSON.stringify({ guestId, guestToken, guestName: 'Spec Guest', commentText: 'Nice shot!' }),
    });
    expect(commentRes.status).toBe(201);

    // Get Photos with limit & cursor
    const getPhotos = await fetch(`${BASE_URL}/api/photos?eventId=${event.id}&limit=10`);
    const photos = await getPhotos.json();
    expect(photos.length).toBeGreaterThan(0);

    // Complete Quest and verify quest list reflects completion.
    // The fingerprint is what a real client sends (H8): without a token or a
    // fingerprint the server no longer mints a guest row per request, so an
    // unidentified caller is asked to join first.
    const completeRes = await fetch(`${BASE_URL}/api/quests/${newQuest.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId: 'anon-guest-str', deviceFingerprint: 'lifecycle-quest-device' }),
    });
    expect(completeRes.status).toBe(200);

    const getQuestsAfterCompletion = await fetch(`${BASE_URL}/api/events/${event.id}/quests`);
    const questsList = await getQuestsAfterCompletion.json();
    expect(questsList.length).toBeGreaterThan(0);
    expect(questsList[0].completedByGuestIds).toBeDefined();

    const deleteQuest = await fetch(`${BASE_URL}/api/quests/${newQuest.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(deleteQuest.status).toBe(200);

    // 10. Audio messages — verify tier gating on celebration_pass
    const lockedAudio = await fetch(`${BASE_URL}/api/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: event.id,
        guestId,
        guestName: 'Spec Guest',
        audioUrl: 'https://cdn.example.com/audio.mp4',
        durationSeconds: 15,
      }),
    });
    expect(lockedAudio.status).toBe(403);

    // Upgrade the host subscription to deluxe_keepsake (subscriptions are the single source of truth)
    await query(
      "UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1",
      [regData.user.id]
    );

    // A real multipart upload with a genuine WebM magic-byte header —
    // audio.ts is multipart-only now (SEC-M3, P7), validating the actual
    // bytes rather than trusting a data: URL's claimed MIME type or an
    // already-hosted URL passthrough.
    const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
    const { body: audioBody, contentType: audioContentType } = buildMultipartAudio(webmHeader, {
      eventId: event.id,
      guestId,
      guestName: 'Spec Guest',
      durationSeconds: '15',
      note: 'Best wishes!',
    });
    const audioRes = await fetch(`${BASE_URL}/api/audio`, {
      method: 'POST',
      headers: { 'Content-Type': audioContentType },
      body: audioBody,
    });
    expect(audioRes.status).toBe(201);

    const getAudio = await fetch(`${BASE_URL}/api/audio?eventId=${event.id}`);
    expect(getAudio.status).toBe(200);

    // 11. Export ZIP Archive
    const zipRes = await fetch(`${BASE_URL}/api/events/${event.id}/export-zip`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get('Content-Type')).toBe('application/zip');

    // 12. Delete photo
    const delPhoto = await fetch(`${BASE_URL}/api/photos/${photoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(delPhoto.status).toBe(200);

    // 13. Public Showcase Feed
    const showcaseRes = await fetch(`${BASE_URL}/api/events/showcase/feed`);
    expect(showcaseRes.status).toBe(200);
    const showcaseData = await showcaseRes.json();
    expect(Array.isArray(showcaseData)).toBe(true);
    // Thirteen sequential round-trips, one of them a bcrypt registration,
    // against a pool capped at 5 per worker (vitest.config.ts). Vitest's 5s
    // default is comfortable on its own and not comfortable under a full
    // parallel run with coverage instrumentation, which makes it a timeout
    // decided by scheduling rather than by anything about the routes.
  }, 30_000);

  it('transliterates a Bulgarian slug and strips punctuation (cleanSlug)', () => {
    // The only direct coverage of cleanSlug's behaviour anywhere — slugConcurrency
    // calls it to build an expected value but asserts nothing about the result,
    // so these two cases are what stands between a transliteration regression
    // and every Bulgarian host's album URL silently changing shape.
    expect(cleanSlug('Светлана & Георги 2026!')).toBe('svetlana-and-georgi-2026');
    expect(cleanSlug('Hello World @ Wedding')).toBe('hello-world-wedding-2026');
  });
});
