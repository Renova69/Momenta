import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { questsRouter } from '../../server/routes/quests';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * The quest leaderboard decides who a host hands a real prize to, so it must
 * count what a guest has shown rather than what they have claimed.
 *
 * Everything here goes through the real routes a phone uses — upload, claim,
 * moderate, delete — because each rule exists to stop one of those routes
 * being used to climb the board. Only the tie-break test reaches into the
 * database, to set completion times a test cannot wait for.
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

async function claim(questId: string, device: Device, guestId: string, photoId?: string) {
  return fetch(`${BASE_URL}/api/quests/${questId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guestId, photoId, deviceFingerprint: device.fingerprint }),
  });
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

  it('scores a quest photo, and nothing for the claim that came before it', async () => {
    const host = await newHost();
    const quest = await addQuest(host, 'First dance', 15);
    const maria = guestDevice('Maria');

    // The phone claims the quest as soon as the photo is taken, before the
    // upload lands. Anyone can send that request, so on its own it is worth
    // nothing.
    const first = await upload(host.eventId, maria);
    expect((await claim(quest, maria, first.guestId)).status).toBe(200);
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

  it("refuses a claim made with somebody else's photo", async () => {
    const host = await newHost();
    const quest = await addQuest(host, 'Group selfie', 30);
    const honest = await upload(host.eventId, guestDevice('Honest'), quest);
    const thief = guestDevice('Thief');
    const thiefGuest = (await upload(host.eventId, thief)).guestId;

    // The claim route takes any photo id it is given.
    expect((await claim(quest, thief, thiefGuest, honest.id)).status).toBe(200);

    expect((await board(host.eventId)).map((e) => e.name)).toEqual(['Honest']);
  });

  it('refuses a claim on one quest made with the photo from another', async () => {
    const host = await newHost();
    const easy = await addQuest(host, 'Easy', 5);
    const hard = await addQuest(host, 'Hard', 100);
    const guest = guestDevice('Stoyan');
    const photo = await upload(host.eventId, guest, easy);

    expect((await claim(hard, guest, photo.guestId, photo.id)).status).toBe(200);

    expect(await board(host.eventId)).toEqual([expect.objectContaining({ name: 'Stoyan', points: 5 })]);
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
