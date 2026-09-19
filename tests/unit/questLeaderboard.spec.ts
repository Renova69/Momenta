import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import { WebSocket } from 'ws';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { questsRouter } from '../../server/routes/quests';
import { wsManager } from '../../server/ws/wsServer';
import { pool, query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * The quest leaderboard decides who a host hands a real prize to, so it must
 * count what a guest has shown rather than what they have claimed.
 *
 * Everything here goes through the real routes a phone uses — upload,
 * moderate, delete — because each rule exists to stop one of those routes
 * being used to climb the board. The database is reached into only to set
 * completion times a test cannot wait for, and to plant the rows a removed
 * claim endpoint could write, which may still sit in a database.
 */

const TEST_PORT = 6671;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';

interface Host {
  token: string;
  userId: string;
  eventId: string;
}

interface Entry {
  rank: number;
  guestId: string;
  name: string;
  points: number;
  questsCompleted: number;
  questIds: string[];
}

const createdEvents: string[] = [];

async function newHost(tier: 'free' | 'celebration_pass' = 'celebration_pass'): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `board-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Leaderboard Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  if (tier !== 'free') {
    await query('UPDATE subscriptions SET tier = $1 WHERE user_id = $2', [tier, data.user.id]);
  }
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

async function addQuest(host: Host, title: string, points: number): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/events/${host.eventId}/quests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ title, points }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

/** Each guest is a phone, identified the way a phone is: by its device fingerprint. */
function guestDevice(name: string) {
  return { name, fingerprint: `board-fp-${name}-${Math.random().toString(36).slice(2, 8)}` };
}

type Device = ReturnType<typeof guestDevice>;

async function upload(eventId: string, device: Device, questId?: string): Promise<{ id: string; guestId: string }> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: device.name,
      deviceFingerprint: device.fingerprint,
      fullUrl: jpegDataUrl,
      ...(questId ? { questId } : {}),
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return { id: body.id, guestId: body.guestId };
}

/**
 * Write a completion row the way the removed `POST /quests/:id/complete` did:
 * any photo id, or none. Nothing in the app writes these now, but rows it
 * wrote may still be in a database, and the board must not count them.
 */
async function plantLegacyClaim(questId: string, guestId: string, photoId: string | null) {
  await query(
    `INSERT INTO guest_quest_completions (quest_id, guest_id, photo_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (quest_id, guest_id) DO UPDATE SET photo_id = EXCLUDED.photo_id`,
    [questId, guestId, photoId]
  );
}

async function board(eventId: string): Promise<Entry[]> {
  const res = await fetch(`${BASE_URL}/api/events/${eventId}/leaderboard`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('quest leaderboard', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    wsManager.init(server);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api', questsRouter);

    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 190, g: 160, b: 120 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await deleteEventFixtures(createdEvents);
    if (server) server.close();
  });

  it('is empty before anyone has played', async () => {
    const host = await newHost();
    await addQuest(host, 'First dance', 10);

    expect(await board(host.eventId)).toEqual([]);
  });

  it('scores a quest photo, and nothing for a completion with no photo behind it', async () => {
    const host = await newHost();
    const quest = await addQuest(host, 'First dance', 15);
    const maria = guestDevice('Maria');

    const first = await upload(host.eventId, maria);
    await plantLegacyClaim(quest, first.guestId, null);
    expect(await board(host.eventId)).toEqual([]);

    await upload(host.eventId, maria, quest);

    expect(await board(host.eventId)).toEqual([
      expect.objectContaining({ rank: 1, guestId: first.guestId, name: 'Maria', points: 15, questsCompleted: 1 }),
    ]);
  });

  it('ranks by points and adds up every quest a guest completed', async () => {
    const host = await newHost();
    const dance = await addQuest(host, 'First dance', 10);
    const cake = await addQuest(host, 'Cake cutting', 25);
    const ivan = guestDevice('Ivan');
    const elena = guestDevice('Elena');

    await upload(host.eventId, ivan, dance);
    await upload(host.eventId, elena, cake);
    await upload(host.eventId, ivan, cake);

    const ranked = await board(host.eventId);

    expect(ranked.map((e) => [e.rank, e.name, e.points, e.questsCompleted])).toEqual([
      [1, 'Ivan', 35, 2],
      [2, 'Elena', 25, 1],
    ]);
    // Each guest's phone marks its quest cards from these.
    expect(ranked[0].questIds.sort()).toEqual([dance, cake].sort());
    expect(ranked[1].questIds).toEqual([cake]);
  });

  it('gives a tie to whoever reached the score first', async () => {
    const host = await newHost();
    const quest = await addQuest(host, 'Bouquet toss', 20);
    const early = guestDevice('Early');
    const late = guestDevice('Late');

    // Uploaded in the "wrong" order, then dated, so insertion order cannot
    // be what decides it.
    await upload(host.eventId, late, quest);
    const earlyGuest = (await upload(host.eventId, early, quest)).guestId;
    await query(
      `UPDATE guest_quest_completions
          SET completed_at = CASE guest_id WHEN $1::uuid THEN NOW() - INTERVAL '2 hours' ELSE NOW() - INTERVAL '1 hour' END
        WHERE quest_id = $2`,
      [earlyGuest, quest]
    );

    expect((await board(host.eventId)).map((e) => e.name)).toEqual(['Early', 'Late']);
  });

  it('drops a photo the host rejects, but keeps one still awaiting a decision', async () => {
    const host = await newHost();
    const quest = await addQuest(host, 'Toast', 10);
    const guest = guestDevice('Petar');
    const photo = await upload(host.eventId, guest, quest);

    const setStatus = (status: string) =>
      fetch(`${BASE_URL}/api/photos/${photo.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ status }),
      });

    expect((await setStatus('pending')).status).toBe(200);
    expect((await board(host.eventId)).map((e) => e.name)).toEqual(['Petar']);

    expect((await setStatus('rejected')).status).toBe(200);
    expect(await board(host.eventId)).toEqual([]);
  });

  it('takes the points away with a photo the host deletes', async () => {
    const host = await newHost();
    const quest = await addQuest(host, 'Toast', 10);
    const photo = await upload(host.eventId, guestDevice('Georgi'), quest);
    expect(await board(host.eventId)).toHaveLength(1);

    const res = await fetch(`${BASE_URL}/api/photos/${photo.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${host.token}` },
    });
    expect(res.status).toBe(200);

    expect(await board(host.eventId)).toEqual([]);
  });

  it("refuses a completion made with somebody else's photo", async () => {
    const host = await newHost();
    const quest = await addQuest(host, 'Group selfie', 30);
    const honest = await upload(host.eventId, guestDevice('Honest'), quest);
    const thiefGuest = (await upload(host.eventId, guestDevice('Thief'))).guestId;

    await plantLegacyClaim(quest, thiefGuest, honest.id);

    expect((await board(host.eventId)).map((e) => e.name)).toEqual(['Honest']);
  });

  it('refuses a completion on one quest made with the photo from another', async () => {
    const host = await newHost();
    const easy = await addQuest(host, 'Easy', 5);
    const hard = await addQuest(host, 'Hard', 100);
    const photo = await upload(host.eventId, guestDevice('Stoyan'), easy);

    await plantLegacyClaim(hard, photo.guestId, photo.id);

    expect(await board(host.eventId)).toEqual([expect.objectContaining({ name: 'Stoyan', points: 5, questIds: [easy] })]);
  });

  it('tells everyone in the room when an upload completes a quest', async () => {
    // With no separate claim request, the upload's completion is the only
    // signal other phones get to move their per-quest counts.
    const host = await newHost();
    const quest = await addQuest(host, 'First dance', 10);
    const ws = new WebSocket(BASE_URL.replace('http', 'ws'));
    const completed: { questId: string; guestId: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket join timed out')), 5000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId: host.eventId })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ROOM_JOINED') {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === 'QUEST_COMPLETED') {
          completed.push(msg.payload);
        }
      });
      ws.on('error', reject);
    });

    try {
      await upload(host.eventId, guestDevice('Plain'));
      const photo = await upload(host.eventId, guestDevice('Dancer'), quest);

      await vi.waitFor(() => expect(completed).toEqual([{ questId: quest, guestId: photo.guestId }]), {
        timeout: 5000,
      });
    } finally {
      ws.close();
    }
  });

  it('stays silent about a completion it failed to record', async () => {
    // Announcing a completion that never reached the database would tick the
    // quest on every phone in the room, until their next sync took it back.
    const host = await newHost();
    const quest = await addQuest(host, 'First dance', 10);
    const ws = new WebSocket(BASE_URL.replace('http', 'ws'));
    const seen: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket join timed out')), 5000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId: host.eventId })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ROOM_JOINED') {
          clearTimeout(timeout);
          resolve();
        } else {
          seen.push(msg.type);
        }
      });
      ws.on('error', reject);
    });

    const realQuery = pool.query.bind(pool);
    const spy = vi.spyOn(pool, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (typeof text === 'string' && text.includes('INSERT INTO guest_quest_completions')) {
        return Promise.reject(new Error('simulated write failure'));
      }
      return (realQuery as (...args: unknown[]) => unknown)(text, ...rest);
    }) as typeof pool.query);

    try {
      // The upload itself still succeeds: the quest credit is best-effort.
      await upload(host.eventId, guestDevice('Unlucky'), quest);
      // PHOTO_ADDED is broadcast after the credit attempt, so once it has
      // arrived, a QUEST_COMPLETED would have too.
      await vi.waitFor(() => expect(seen).toContain('PHOTO_ADDED'), { timeout: 5000 });
      expect(seen).not.toContain('QUEST_COMPLETED');
    } finally {
      spy.mockRestore();
      ws.close();
    }
  });

  it('has no route to claim a quest without a photo', async () => {
    const host = await newHost();
    const quest = await addQuest(host, 'First dance', 10);

    const res = await fetch(`${BASE_URL}/api/quests/${quest}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId: 'anyone', deviceFingerprint: 'any-device' }),
    });

    expect(res.status).toBe(404);
    const { rows } = await query('SELECT 1 FROM guest_quest_completions WHERE quest_id = $1', [quest]);
    expect(rows).toHaveLength(0);
  });

  it("does not let an upload to one wedding score on another wedding's quest", async () => {
    const mine = await newHost();
    const theirs = await newHost();
    const theirQuest = await addQuest(theirs, 'Their quest', 50);

    const photo = await upload(mine.eventId, guestDevice('Intruder'), theirQuest);

    expect(await board(theirs.eventId)).toEqual([]);
    // Nor is the photo labelled with the other wedding's quest.
    const { rows } = await query('SELECT quest_id FROM photos WHERE id = $1', [photo.id]);
    expect(rows[0].quest_id).toBeNull();
  });

  it('is part of the paid quest feature', async () => {
    const host = await newHost('free');

    const res = await fetch(`${BASE_URL}/api/events/${host.eventId}/leaderboard`);

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('TIER_REQUIRED');
  });
});
