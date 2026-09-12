import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { wsManager } from '../server/ws/wsServer';
import { authRouter } from '../server/routes/auth';
import { eventsRouter } from '../server/routes/events';
import { photosRouter } from '../server/routes/photos';
import { questsRouter } from '../server/routes/quests';
import { audioRouter } from '../server/routes/audio';
import { guestsRouter } from '../server/routes/guests';
import { pool } from '../server/lib/db';
import { purgeTestData } from '../scripts/purge-test-data';

const TEST_PORT = 6589;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const WS_URL = `ws://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;

async function setupTestServer() {
  const app = express();
  server = createServer(app);
  wsManager.init(server);

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
  console.log(`[E2E Server] Test server running on port ${TEST_PORT}`);
}

async function runE2ETests() {
  console.log('\n========================================');
  console.log('🧪 RUNNING FULL WEDMOMENTS E2E TEST SUITE');
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      failed++;
    }
  }

  try {
    await setupTestServer();

    // -------------------------------------------------------------
    // SUITE 1: AUTHENTICATION & SECURITY
    // -------------------------------------------------------------
    console.log('\n--- SUITE 1: Authentication, Passwords & JWT ---');
    const testEmail = `host-${Date.now()}@example.com`;
    const testPassword = 'Password123!';
    const testFullName = 'Alexander & Maria';

    // 1.1 Register new host
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        fullName: testFullName,
        password: testPassword,
        role: 'couple',
      }),
    });
    const regData = await regRes.json();
    assert(regRes.status === 201 && !!regData.token, 'Host registration issues JWT token');
    assert(!!regData.event && !!regData.event.slug, 'Registration auto-provisions wedding event with slug');
    assert(!regData.user.password_hash, 'Password hash is strictly hidden from response');

    const hostToken = regData.token;
    const testEvent = regData.event;

    // 1.2 Login with valid credentials
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    const loginData = await loginRes.json();
    assert(loginRes.status === 200 && !!loginData.token, 'Host login succeeds with valid bcrypt password');

    // 1.3 Login with invalid password
    const badLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: 'WrongPassword!' }),
    });
    assert(badLoginRes.status === 401, 'Login with incorrect password returns 401 Unauthorized');

    // 1.4 GET /api/auth/me with Bearer token
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    const meData = await meRes.json();
    assert(meRes.status === 200 && meData.user.email === testEmail, 'GET /api/auth/me returns authenticated host profile');

    // 1.5 GET /api/auth/me without token
    const unauthMe = await fetch(`${BASE_URL}/api/auth/me`);
    assert(unauthMe.status === 401, 'GET /api/auth/me without token returns 401');

    // -------------------------------------------------------------
    // SUITE 2: MULTI-TENANT EVENTS & PRIVACY
    // -------------------------------------------------------------
    console.log('\n--- SUITE 2: Multi-Tenant Events & Settings ---');

    // 2.1 Public slug endpoint hides PII
    const publicEventRes = await fetch(`${BASE_URL}/api/events/slug/${encodeURIComponent(testEvent.slug)}`);
    const publicEvent = await publicEventRes.json();
    assert(publicEventRes.status === 200, 'Public event slug resolves successfully');
    assert(!publicEvent.host_email && !publicEvent.host_user_id, 'Public event endpoint strips host email & user ID');

    // 2.2 Host update with nullable values
    const updateRes = await fetch(`${BASE_URL}/api/events/${testEvent.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`,
      },
      body: JSON.stringify({
        venueName: 'Tuscany Grand Estate',
        revealAt: null,
      }),
    });
    const updatedEvent = await updateRes.json();
    assert(updateRes.status === 200 && updatedEvent.venue_name === 'Tuscany Grand Estate', 'Host event settings updated successfully');

    // 2.3 QR Canvas Config
    const qrGet = await fetch(`${BASE_URL}/api/events/${testEvent.id}/qr-config`);
    const qrData = await qrGet.json();
    assert(qrGet.status === 200 && (qrData.eventId === testEvent.id || qrData.event_id === testEvent.id), 'GET QR canvas config returns event settings');

    // -------------------------------------------------------------
    // SUITE 3: GUEST IDENTITY & ONBOARDING
    // -------------------------------------------------------------
    console.log('\n--- SUITE 3: Guest Identity & Atomic Upsert ---');
    const deviceFp = `dev-${Date.now()}-abc`;

    // 3.1 Register guest
    const guestRes = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: testEvent.id,
        name: 'Sophie & James',
        tableNumber: 'Table 7',
        deviceFingerprint: deviceFp,
      }),
    });
    const guestData = await guestRes.json();
    assert(guestRes.status === 201 && !!guestData.id, 'Guest registration succeeds');
    const guestId = guestData.id;
    const guestToken = guestData.guestToken;

    // 3.2 Atomic upsert on same device fingerprint
    const guestUpdate = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: testEvent.id,
        name: 'Sophie & James (Updated)',
        deviceFingerprint: deviceFp,
      }),
    });
    const guestUpdated = await guestUpdate.json();
    assert(guestUpdated.id === guestId && guestUpdated.name === 'Sophie & James (Updated)', 'Guest re-registration atomically updates existing record');

    // 3.3 Lookup guest by fingerprint
    const guestLookup = await fetch(`${BASE_URL}/api/guests?eventId=${testEvent.id}&deviceFingerprint=${deviceFp}`);
    const foundGuest = await guestLookup.json();
    assert(guestLookup.status === 200 && foundGuest.id === guestId, 'Guest session rehydration via fingerprint succeeds');

    // -------------------------------------------------------------
    // SUITE 4: REAL-TIME WEBSOCKETS & BROADCASTS
    // -------------------------------------------------------------
    console.log('\n--- SUITE 4: Real-Time WebSockets & Scoped Rooms ---');

    let wsReceivedType: string | null = null;
    let wsRoomJoined = false;

    const wsClient = new WebSocket(WS_URL);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 4000);

      wsClient.on('open', () => {
        // Authenticated via a post-handshake message, not a ?token= query
        // parameter (SEC-A5) — see wsServer.ts's 'AUTH' case.
        wsClient.send(JSON.stringify({ type: 'AUTH', token: hostToken }));
        wsClient.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId: testEvent.id }));
      });

      wsClient.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ROOM_JOINED') {
          wsRoomJoined = true;
          assert(msg.eventId === testEvent.id && msg.isHost === true, 'WebSocket room joined with verified host privilege');
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === 'PHOTO_ADDED' || msg.type === 'PHOTO_LIKED') {
          wsReceivedType = msg.type;
        }
      });

      wsClient.on('error', (e) => {
        clearTimeout(timeout);
        reject(e);
      });
    });

    assert(wsRoomJoined, 'WebSocket connected and verified room subscription');

    // -------------------------------------------------------------
    // SUITE 5: PHOTOS, RAW UPLOADS & REACTIONS
    // -------------------------------------------------------------
    console.log('\n--- SUITE 5: Photos, Magic Bytes & Reactions ---');

    // 5.1 /api/photos/upload/raw was removed (SEC-02) — it wrote to storage
    // with no photos/audio row, permanently invisible to quota accounting,
    // and had zero real callers once P7 moved audio off of it. Confirm it's
    // actually gone.
    const removedRawUpload = await fetch(`${BASE_URL}/api/photos/upload/raw`, { method: 'POST' });
    assert(removedRawUpload.status === 404, 'Raw upload endpoint no longer exists (SEC-02)');

    // 5.2 A real, decodable JPEG — /api/photos runs it through sharp before
    // saving (SEC-M4), so header-only magic bytes are no longer enough here.
    const validJpegBytes = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    // 5.3 Post Photo to Feed
    const photoRes = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: testEvent.id,
        guestId: guestId,
        guestName: 'Sophie & James',
        fullUrl: `data:image/jpeg;base64,${validJpegBytes.toString('base64')}`,
        caption: 'Wishing you endless love and happiness! 🥂',
        filterApplied: 'golden_glow',
      }),
    });
    const photoData = await photoRes.json();
    assert(photoRes.status === 201 && !!photoData.id, 'Photo created and published to wedding album');
    const photoId = photoData.id;

    // Wait 200ms for WebSocket broadcast to arrive
    await new Promise((r) => setTimeout(r, 200));
    assert(wsReceivedType === 'PHOTO_ADDED', 'WebSocket received PHOTO_ADDED broadcast for room in real-time');

    // 5.4 Like Photo
    const likeRes = await fetch(`${BASE_URL}/api/photos/${photoId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, guestToken }),
    });
    const likeData = await likeRes.json();
    assert(likeRes.status === 200 && likeData.isLiked === true, 'Photo like toggled successfully');

    // 5.5 Add Comment
    const commentRes = await fetch(`${BASE_URL}/api/photos/${photoId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guestId,
        // Carries the token the upload handed back, as the real client does —
        // the like call above already does. Since H8 a comment must identify
        // either a token or a device; it no longer mints a guest row for a
        // caller that identifies neither.
        guestToken,
        guestName: 'Sophie & James',
        commentText: 'Such a stunning moment!',
      }),
    });
    const commentData = await commentRes.json();
    assert(commentRes.status === 201 && commentData.photoId === photoId, 'Photo comment added and returned');

    // 5.6 GET Photos for Event
    const listPhotos = await fetch(`${BASE_URL}/api/photos?eventId=${testEvent.id}`);
    const photosList = await listPhotos.json();
    assert(listPhotos.status === 200 && photosList.length > 0, 'GET /api/photos returns event photo stream');
    assert(photosList[0].comments.length > 0, 'Photo comments aggregated in photo stream query');

    // -------------------------------------------------------------
    // SUITE 6: SCAVENGER QUESTS & AUDIO GUESTBOOK
    // -------------------------------------------------------------
    console.log('\n--- SUITE 6: Scavenger Quests & Audio Guestbook ---');

    // 6.1 List Quests
    const questsRes = await fetch(`${BASE_URL}/api/events/${testEvent.id}/quests`);
    const questsList = await questsRes.json();
    assert(questsRes.status === 200 && questsList.length > 0, 'Scavenger quests retrieved for event');
    const questId = questsList[0].id;

    // 6.2 Complete Quest without photo
    const completeRes = await fetch(`${BASE_URL}/api/quests/${questId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId }),
    });
    await completeRes.json();
    // /api/audio is multipart-only (P7) — a real WebM magic-byte header,
    // not base64-in-JSON.
    const webmHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
    const audioForm = (fields: Record<string, string>): FormData => {
      const form = new FormData();
      form.append('audio', new Blob([webmHeader], { type: 'audio/webm' }), 'test.webm');
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      return form;
    };

    // 6.3 Tier Gating: Audio is locked on celebration_pass
    const lockedAudioRes = await fetch(`${BASE_URL}/api/audio`, {
      method: 'POST',
      body: audioForm({ eventId: testEvent.id, guestId, guestName: 'Sophie & James', durationSeconds: '18' }),
    });
    assert(lockedAudioRes.status === 403, 'Tier Gate blocks audio guestbook on celebration_pass plan');

    // Upgrade the host subscription to deluxe_keepsake (subscriptions are the single source of truth)
    await pool.query(
      "UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1",
      [regData.user.id]
    );

    // Post Audio Guestbook message on unlocked deluxe event
    const audioRes = await fetch(`${BASE_URL}/api/audio`, {
      method: 'POST',
      body: audioForm({
        eventId: testEvent.id,
        guestId,
        guestName: 'Sophie & James',
        durationSeconds: '18',
        note: 'From the best friends with so much love!',
      }),
    });
    const audioData = await audioRes.json();
    assert(audioRes.status === 201 && !!audioData.id, 'Audio guestbook message saved successfully on deluxe tier');

    // 6.4 GET Audio Guestbook
    const getAudio = await fetch(`${BASE_URL}/api/audio?eventId=${testEvent.id}`);
    const audioList = await getAudio.json();
    assert(getAudio.status === 200 && audioList.length > 0, 'GET /api/audio retrieves audio messages for event');

    wsClient.close();
  } finally {
    // The e2e suite runs under tsx, not vitest, so vitest.config.ts's
    // globalSetup teardown never sees it — without this it keeps leaking
    // fixture rows into the database exactly as the unit suite used to.
    // In `finally` so a failed run cleans up too, and swallowing errors so
    // tidying up can never turn a passing suite into a failing one.
    try {
      const { events, users, mediaBytes } = await purgeTestData(false);
      if (events > 0 || users > 0) {
        const mb = (mediaBytes / 1024 / 1024).toFixed(1);
        console.log(`
[cleanup] removed ${events} test event(s), ${users} test user(s), ${mb} MB of media`);
      }
    } catch (err) {
      console.warn('[cleanup] could not purge test data:', err instanceof Error ? err.message : String(err));
    }

    if (server) {
      server.close();
    }
    await pool.end();
  }

  console.log('\n========================================');
  console.log(`🏁 E2E RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runE2ETests().catch((err) => {
  console.error('\n💥 FATAL E2E ERROR:', err);
  if (server) server.close();
  pool.end();
  process.exit(1);
});
