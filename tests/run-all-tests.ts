// Unit coverage lives in tests/unit/*.spec.ts and runs under Vitest
// (`npm run test:unit`). This runner owns only the full-stack pass: a live
// Express server, a real PostgreSQL database, and real WebSocket clients.
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

const TEST_PORT = 6590;
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
}

async function runAllSpecs() {
  const startTime = Date.now();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       WEDMOMENTS FULL-STACK E2E SUITE (requires PostgreSQL)  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  let totalPassed = 0;
  let totalFailed = 0;

  // -------------------------------------------------------------
  // END-TO-END & INTEGRATION TEST SUITES
  // -------------------------------------------------------------
  console.log('\n================ [PHASE 2: FULL E2E & REAL-TIME SPECS] ================');

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      totalPassed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      totalFailed++;
    }
  }

  try {
    await setupTestServer();

    // 1. Auth & JWT
    console.log('\n--- E2E Spec: Authentication & Passwords ---');
    const testEmail = `host-spec-${Date.now()}@example.com`;
    const testPassword = 'Password123!';
    const testFullName = 'Alexander & Maria';

    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, fullName: testFullName, password: testPassword, role: 'couple' }),
    });
    const regData = await regRes.json();
    assert(regRes.status === 201 && !!regData.token, 'Registration issues JWT token');
    assert(!!regData.event && !!regData.event.slug, 'Registration provisions event with slug');
    assert(!regData.user.password_hash, 'Password hash is strictly hidden from API');

    const hostToken = regData.token;
    const testEvent = regData.event;

    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    assert(loginRes.status === 200, 'Host login succeeds with bcrypt password');

    const badLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: 'WrongPassword!' }),
    });
    assert(badLoginRes.status === 401, 'Login with wrong password returns 401');

    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    const meData = await meRes.json();
    assert(meRes.status === 200 && meData.user.email === testEmail, 'GET /api/auth/me returns host profile');

    const unauthMe = await fetch(`${BASE_URL}/api/auth/me`);
    assert(unauthMe.status === 401, 'GET /api/auth/me without token returns 401');

    // 2. Events & Privacy
    console.log('\n--- E2E Spec: Multi-Tenant Events & Privacy ---');
    const publicEventRes = await fetch(`${BASE_URL}/api/events/slug/${encodeURIComponent(testEvent.slug)}`);
    const publicEvent = await publicEventRes.json();
    assert(publicEventRes.status === 200, 'Public event slug endpoint resolves');
    assert(!publicEvent.host_email && !publicEvent.host_user_id, 'Public event strips host PII');

    const updateRes = await fetch(`${BASE_URL}/api/events/${testEvent.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ venueName: 'Tuscany Grand Estate', revealAt: null }),
    });
    const updatedEvent = await updateRes.json();
    assert(updateRes.status === 200 && updatedEvent.venue_name === 'Tuscany Grand Estate', 'Host updates event settings with nullable support');

    const qrGet = await fetch(`${BASE_URL}/api/events/${testEvent.id}/qr-config`);
    const qrData = await qrGet.json();
    assert(qrGet.status === 200 && (qrData.eventId === testEvent.id || qrData.event_id === testEvent.id), 'GET QR canvas config returns event settings');

    // 3. Guest Identity
    console.log('\n--- E2E Spec: Guest Registration & Identity ---');
    const deviceFp = `dev-${Date.now()}-xyz`;

    const guestRes = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: testEvent.id, name: 'Sophie & James', tableNumber: 'Table 7', deviceFingerprint: deviceFp }),
    });
    const guestData = await guestRes.json();
    assert(guestRes.status === 201 && !!guestData.id, 'Guest registration succeeds');
    const guestId = guestData.id;
    const guestToken = guestData.guestToken;

    const guestUpdate = await fetch(`${BASE_URL}/api/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: testEvent.id, name: 'Sophie & James (Updated)', deviceFingerprint: deviceFp }),
    });
    const guestUpdated = await guestUpdate.json();
    assert(guestUpdated.id === guestId && guestUpdated.name === 'Sophie & James (Updated)', 'Guest re-registration atomically updates existing record');

    const guestLookup = await fetch(`${BASE_URL}/api/guests?eventId=${testEvent.id}&deviceFingerprint=${deviceFp}`);
    const foundGuest = await guestLookup.json();
    assert(guestLookup.status === 200 && foundGuest.id === guestId, 'Guest session rehydration succeeds');

    // 4. WebSockets
    console.log('\n--- E2E Spec: Real-Time WebSockets ---');
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

    // 5. Photos & Moderation
    console.log('\n--- E2E Spec: Photos, Magic Bytes & Moderation ---');

    // /api/photos/upload/raw was removed (SEC-02) — wrote to storage with no
    // photos/audio row, permanently invisible to quota accounting, and had
    // zero real callers once P7 moved audio off of it.
    const removedRawUpload = await fetch(`${BASE_URL}/api/photos/upload/raw`, { method: 'POST' });
    assert(removedRawUpload.status === 404, 'Raw upload endpoint no longer exists (SEC-02)');

    // A real, decodable JPEG — /api/photos runs it through sharp (SEC-M4).
    const validJpegBytes = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    const photoRes = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: testEvent.id,
        guestId: guestId,
        guestName: 'Sophie & James',
        fullUrl: `data:image/jpeg;base64,${validJpegBytes.toString('base64')}`,
        caption: 'Celebrating true love! 🥂',
        filterApplied: 'vintage_polaroid',
      }),
    });
    const photoData = await photoRes.json();
    assert(photoRes.status === 201 && !!photoData.id, 'Photo created in wedding album');
    const photoId = photoData.id;

    await new Promise((r) => setTimeout(r, 200));
    assert(wsReceivedType === 'PHOTO_ADDED', 'WebSocket received PHOTO_ADDED broadcast');

    const likeRes = await fetch(`${BASE_URL}/api/photos/${photoId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, guestToken }),
    });
    const likeData = await likeRes.json();
    assert(likeRes.status === 200 && likeData.isLiked === true, 'Photo like toggled');

    const commentRes = await fetch(`${BASE_URL}/api/photos/${photoId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, guestName: 'Sophie & James', commentText: 'What a beautiful shot!' }),
    });
    assert(commentRes.status === 201, 'Photo comment added');

    const listPhotos = await fetch(`${BASE_URL}/api/photos?eventId=${testEvent.id}`);
    const photosList = await listPhotos.json();
    assert(listPhotos.status === 200 && photosList.length > 0, 'GET /api/photos returns photo stream');
    assert(photosList[0].comments.length > 0, 'Comments aggregated in photo feed');

    // 6. Quests & Audio
    console.log('\n--- E2E Spec: Quests & Audio Guestbook ---');
    const questsRes = await fetch(`${BASE_URL}/api/events/${testEvent.id}/quests`);
    const questsList = await questsRes.json();
    assert(questsRes.status === 200 && questsList.length > 0, 'Quests retrieved for event');
    const questId = questsList[0].id;

    const completeRes = await fetch(`${BASE_URL}/api/quests/${questId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId }),
    });
    assert(completeRes.status === 200, 'Quest completed with null photo');

    // /api/audio is multipart-only (P7) — a real WebM magic-byte header,
    // not base64-in-JSON.
    const webmHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
    const audioForm = (fields: Record<string, string>): FormData => {
      const form = new FormData();
      form.append('audio', new Blob([webmHeader], { type: 'audio/webm' }), 'test.webm');
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      return form;
    };

    // Tier Gate check: Audio is blocked on celebration_pass
    const blockedAudio = await fetch(`${BASE_URL}/api/audio`, {
      method: 'POST',
      body: audioForm({ eventId: testEvent.id, guestId, guestName: 'Sophie & James', durationSeconds: '20' }),
    });
    assert(blockedAudio.status === 403, 'Tier Gate blocks audio on celebration_pass plan');

    // Upgrade the host subscription to deluxe_keepsake (subscriptions are the single source of truth)
    await pool.query(
      "UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1",
      [regData.user.id]
    );

    const audioRes = await fetch(`${BASE_URL}/api/audio`, {
      method: 'POST',
      body: audioForm({
        eventId: testEvent.id,
        guestId,
        guestName: 'Sophie & James',
        durationSeconds: '20',
        note: 'Best wishes from the table 7 gang!',
      }),
    });
    assert(audioRes.status === 201, 'Audio guestbook entry created on deluxe plan');

    const getAudio = await fetch(`${BASE_URL}/api/audio?eventId=${testEvent.id}`);
    const audioList = await getAudio.json();
    assert(getAudio.status === 200 && audioList.length > 0, 'GET /api/audio retrieves voice messages');

    wsClient.close();
  } finally {
    if (server) server.close();
    await pool.end();
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n================================================================');
  console.log(`🏁 SPEC RESULTS: ${totalPassed} PASSED | ${totalFailed} FAILED | Execution Time: ${durationSec}s`);
  console.log('================================================================\n');

  if (totalFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllSpecs().catch((err) => {
  console.error('\n💥 TEST HARNESS FATAL ERROR:', err);
  if (server) server.close();
  pool.end();
  process.exit(1);
});
