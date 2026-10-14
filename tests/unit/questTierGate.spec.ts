import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { questsRouter } from '../../server/routes/quests';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-123 — quests are a Celebration Pass feature, and on a free album they were
 * half there. Registration seeds five quests into every album; guests on a free
 * one could see and complete them, while the host's quest tab was locked (so
 * the host could not remove them) and the leaderboard refused to load.
 *
 * Below Celebration Pass the quests are now not offered and a photo does not
 * complete one. They stay in the album, ready, for when the host upgrades.
 */

const TEST_PORT = 6677;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

async function registerHost(): Promise<{ userId: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `questgate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Quest Gate Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { userId: data.user.id, eventId: data.event.id };
}

const quests = async (eventId: string) => (await fetch(`${BASE_URL}/api/events/${eventId}/quests`)).json();

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/photos', photosRouter);
  app.use('/api', questsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 10, g: 120, b: 60 } } })
    .jpeg()
    .toBuffer();
  jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  if (server) server.close();
});

describe('quests on a free album (N-123)', () => {
  it('are not offered to guests', async () => {
    const host = await registerHost();
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM scavenger_quests WHERE event_id = $1', [host.eventId]);
    expect(rows[0].n).toBeGreaterThan(0);

    expect(await quests(host.eventId)).toEqual([]);
  });

  it('are not completed by a photo that names one', async () => {
    const host = await registerHost();
    const { rows } = await query('SELECT id FROM scavenger_quests WHERE event_id = $1 LIMIT 1', [host.eventId]);

    const res = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: host.eventId,
        guestName: 'Quest Guest',
        deviceFingerprint: `questgate-${Math.random().toString(36).slice(2, 10)}`,
        fullUrl: jpegDataUrl,
        questId: rows[0].id,
      }),
    });

    expect(res.status).toBe(201);
    const photo = await res.json();
    const stored = await query('SELECT quest_id FROM photos WHERE id = $1', [photo.id]);
    expect(stored.rows[0].quest_id).toBeNull();
    const completions = await query('SELECT 1 FROM guest_quest_completions WHERE quest_id = $1', [rows[0].id]);
    expect(completions.rows).toHaveLength(0);
  });

  it('come back, as seeded, when the host upgrades', async () => {
    const host = await registerHost();
    await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);

    expect((await quests(host.eventId)).length).toBe(5);
  });
});

/**
 * N-128 — the leaderboard drops a quest whose photo the host rejected, but
 * the quest list kept the guest as having completed it: the guest's tick and
 * the host's "1 completed" stayed while the points were gone.
 */
describe('a quest whose photo was rejected (N-128)', () => {
  it('no longer lists the guest as having completed it', async () => {
    const host = await registerHost();
    await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [host.userId]);
    const quest = (await query('SELECT id FROM scavenger_quests WHERE event_id = $1 LIMIT 1', [host.eventId])).rows[0].id;
    const guest = (await query(`INSERT INTO guests (event_id, name) VALUES ($1, 'Q') RETURNING id`, [host.eventId])).rows[0].id;
    const photo = (
      await query(
        `INSERT INTO photos (event_id, guest_id, quest_id, storage_path, full_url, status)
         VALUES ($1, $2, $3, '/x.jpg', '/x.jpg', 'pending') RETURNING id`,
        [host.eventId, guest, quest]
      )
    ).rows[0].id;
    await query('INSERT INTO guest_quest_completions (quest_id, guest_id, photo_id) VALUES ($1, $2, $3)', [quest, guest, photo]);

    const before = (await quests(host.eventId)).find((q: { id: string }) => q.id === quest);
    expect(before.completedByGuestIds).toContain(guest);

    await query(`UPDATE photos SET status = 'rejected' WHERE id = $1`, [photo]);

    const after = (await quests(host.eventId)).find((q: { id: string }) => q.id === quest);
    expect(after.completedByGuestIds).not.toContain(guest);
  });
});
