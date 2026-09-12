import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { questsRouter } from '../../server/routes/quests';
import { guestsRouter } from '../../server/routes/guests';
import { query } from '../../server/lib/db';

/**
 * H8 — unauthenticated, unthrottled guest-row minting.
 *
 * POST /api/photos/:id/comments and POST /api/quests/:id/complete both
 * accepted a request carrying no credential at all and INSERTed a fresh
 * `guests` row on every single call. Comments had no rate limiter beyond the
 * global apiLimiter (3000/min/IP), and `guests` has no quota of any kind.
 *
 * Anyone with a public event slug could therefore create unbounded guest rows:
 * the host's guest list fills with ghosts, the showcase guest count inflates,
 * and the table grows without bound. Minting on *every* unproven request is
 * the defect — not anonymous participation itself, which stays supported.
 *
 * Resolution is now the same ladder the photo-upload path already uses:
 * a verified token identifies the guest; failing that a device fingerprint
 * attributes the action to the row that device already owns; failing that one
 * row is created for that device. A caller offering neither is asked to
 * identify itself rather than handed a brand-new identity.
 *
 * The SEC-03 rule carries over too: a fingerprint is client-generated and not
 * secret, so matching one is enough to attribute an action but never enough to
 * be issued a durable credential for that identity.
 */

const TEST_PORT = 6634;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

interface Host {
  token: string;
  eventId: string;
}

async function registerHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `minting-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Guest Minting Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, eventId: data.event.id };
}

async function uploadPhoto(eventId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Minting Spec Guest',
      deviceFingerprint: `mint-owner-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  return (await res.json()).id as string;
}

async function guestCount(eventId: string): Promise<number> {
  const res = await query<{ count: string }>('SELECT COUNT(*)::int AS count FROM guests WHERE event_id = $1', [
    eventId,
  ]);
  return Number(res.rows[0].count);
}

function postComment(photoId: string, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/photos/${photoId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commentText: 'Lovely shot!', ...body }),
  });
}

function completeQuest(questId: string, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/quests/${questId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function firstQuestId(eventId: string): Promise<string> {
  const res = await query<{ id: string }>('SELECT id FROM scavenger_quests WHERE event_id = $1 LIMIT 1', [eventId]);
  return res.rows[0].id;
}

describe('guest rows are not minted per request (H8)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/guests', guestsRouter);
    app.use('/api', questsRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 200, g: 170, b: 120 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  describe('POST /api/photos/:id/comments', () => {
    it('refuses a caller offering neither a token nor a fingerprint', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const before = await guestCount(host.eventId);

      const res = await postComment(photoId, { guestId: 'not-a-uuid', guestName: 'Ghost' });

      expect(res.status).toBe(401);
      expect(await guestCount(host.eventId)).toBe(before);
    });

    it('creates at most one row for a device, however many comments it posts', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const before = await guestCount(host.eventId);
      const fingerprint = `mint-fp-${Math.random().toString(36).slice(2, 8)}`;

      for (let i = 0; i < 5; i++) {
        const res = await postComment(photoId, { guestId: 'unknown', guestName: 'Repeat', deviceFingerprint: fingerprint });
        expect(res.status).toBe(201);
      }

      expect(await guestCount(host.eventId)).toBe(before + 1);
    });

    it('issues a token for a genuinely new device, but not for a fingerprint-only match (SEC-03)', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const fingerprint = `mint-fp-${Math.random().toString(36).slice(2, 8)}`;

      const first = await postComment(photoId, { guestId: 'unknown', guestName: 'Newcomer', deviceFingerprint: fingerprint });
      const firstBody = await first.json();
      expect(first.status).toBe(201);
      expect(typeof firstBody.guestToken).toBe('string');

      const second = await postComment(photoId, { guestId: 'unknown', guestName: 'Newcomer', deviceFingerprint: fingerprint });
      const secondBody = await second.json();
      expect(second.status).toBe(201);
      expect(secondBody.guestId).toBe(firstBody.guestId);
      expect(secondBody.guestToken).toBeUndefined();
    });

    it('attributes the comment to the token holder without creating a row', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const fingerprint = `mint-fp-${Math.random().toString(36).slice(2, 8)}`;

      const seed = await postComment(photoId, { guestId: 'unknown', guestName: 'Tokened', deviceFingerprint: fingerprint });
      const { guestId, guestToken } = await seed.json();

      const before = await guestCount(host.eventId);
      const res = await postComment(photoId, { guestId, guestToken });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.guestId).toBe(guestId);
      expect(await guestCount(host.eventId)).toBe(before);
    });

    it('is rate limited per device, not merely by the global API ceiling', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const fingerprint = `mint-flood-${Math.random().toString(36).slice(2, 8)}`;

      // Fired together rather than in a sequential loop. The limiter allows 20
      // per minute per device, so 25 requests must produce at least one 429
      // whatever order they arrive in — the assertion stays deterministic
      // while the test stops depending on 40 round trips finishing inside the
      // timeout, which stopped being reliable as the suite grew and more spec
      // files competed for the machine.
      const responses = await Promise.all(
        Array.from({ length: 25 }, () =>
          postComment(photoId, { guestId: 'unknown', deviceFingerprint: fingerprint })
        )
      );

      expect(responses.some((res) => res.status === 429)).toBe(true);
      // An explicit budget rather than the 5s default. What this test asserts
      // is deterministic — 25 requests against a 20-per-minute limiter must
      // produce a 429 — but it needs a register, an upload and 25 round trips
      // to get there, and it is racing every other spec file for the machine.
      // Parallelising the requests bought it some room once already; the
      // suite has since grown past that too. Widening the clock does not
      // weaken the assertion, and leaves a failure here meaning the limiter
      // is broken rather than that the runner was busy.
    }, 20_000);
  });

  describe('POST /api/quests/:id/complete', () => {
    it('refuses a caller offering neither a token nor a fingerprint', async () => {
      const host = await registerHost();
      const questId = await firstQuestId(host.eventId);
      const before = await guestCount(host.eventId);

      const res = await completeQuest(questId, { guestId: 'not-a-uuid' });

      expect(res.status).toBe(401);
      expect(await guestCount(host.eventId)).toBe(before);
    });

    it('creates at most one row for a device across repeated completions', async () => {
      const host = await registerHost();
      const questId = await firstQuestId(host.eventId);
      const before = await guestCount(host.eventId);
      const fingerprint = `mint-q-${Math.random().toString(36).slice(2, 8)}`;

      for (let i = 0; i < 4; i++) {
        const res = await completeQuest(questId, { guestId: 'unknown', deviceFingerprint: fingerprint });
        expect(res.status).toBe(200);
      }

      expect(await guestCount(host.eventId)).toBe(before + 1);
    });

    it('does not hand a credential to a fingerprint-only match (SEC-03)', async () => {
      const host = await registerHost();
      const questId = await firstQuestId(host.eventId);
      const fingerprint = `mint-q-${Math.random().toString(36).slice(2, 8)}`;

      const first = await (await completeQuest(questId, { guestId: 'unknown', deviceFingerprint: fingerprint })).json();
      expect(typeof first.guestToken).toBe('string');

      const second = await (await completeQuest(questId, { guestId: 'unknown', deviceFingerprint: fingerprint })).json();
      expect(second.guestId).toBe(first.guestId);
      expect(second.guestToken).toBeUndefined();
    });
  });

  it('still rejects a reserved device fingerprint on these paths', async () => {
    const host = await registerHost();
    const photoId = await uploadPhoto(host.eventId);

    const res = await postComment(photoId, { guestId: 'unknown', deviceFingerprint: 'photographer' });

    expect(res.status).toBe(400);
  });
});
