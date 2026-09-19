import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { WebSocket } from 'ws';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { wsManager } from '../../server/ws/wsServer';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * The quest grand prize, end to end on the server.
 *
 * A host writes the prize in the dashboard; every guest reads it above the
 * quest list. It reaches guests two ways — the public slug endpoint on load,
 * and the EVENT_UPDATED broadcast while they are already watching — and both
 * are projections that list their columns by hand. A column missing from
 * either one is a prize the host saved and no guest ever sees, with nothing
 * failing anywhere.
 *
 * The length cap lives in UpdateEventSchema rather than on the column (see
 * migration 027), so the boundary is pinned here or nowhere.
 *
 * The TV-wall leaderboard switch (migration 028) travels the same two roads
 * to an unauthenticated screen, so it is pinned here too.
 */

const TEST_PORT = 6670;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const WS_URL = `ws://localhost:${TEST_PORT}`;

let server: ReturnType<typeof createServer>;

interface Session {
  token: string;
  eventId: string;
  slug: string;
}

async function registerHost(): Promise<Session> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `prize-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Grand Prize Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { token: data.token, eventId: data.event.id, slug: data.event.slug };
}

function updateEvent(host: Session, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/events/${host.eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify(body),
  });
}

async function publicPrize(host: Session): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/events/slug/${encodeURIComponent(host.slug)}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('quest_prize');
  return body.quest_prize;
}

/** An unauthenticated guest socket in the event room, recording EVENT_UPDATED frames. */
async function joinAsGuest(eventId: string) {
  const ws = new WebSocket(WS_URL);
  const updates: Record<string, unknown>[] = [];

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket join timed out')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ROOM_JOINED') {
        clearTimeout(timeout);
        resolve();
      } else if (msg.type === 'EVENT_UPDATED') {
        updates.push(msg.payload || {});
      }
    });
    ws.on('error', reject);
  });

  return { updates, close: () => ws.close() };
}

describe('quest grand prize', () => {
  const createdEvents: string[] = [];

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    wsManager.init(server);
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);

    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await deleteEventFixtures(createdEvents);
    if (server) server.close();
  });

  async function newHost(): Promise<Session> {
    const host = await registerHost();
    createdEvents.push(host.eventId);
    return host;
  }

  it('starts unset, so guests see the localized default', async () => {
    const host = await newHost();

    expect(await publicPrize(host)).toBeNull();
  });

  it('reaches guests on load and live, from a single save', async () => {
    const host = await newHost();
    const guest = await joinAsGuest(host.eventId);

    try {
      const prize = 'Уикенд в Созопол за двама 🏖️';
      const res = await updateEvent(host, { questPrize: prize });

      expect(res.status).toBe(200);
      expect((await res.json()).quest_prize).toBe(prize);
      expect(await publicPrize(host)).toBe(prize);

      await vi.waitFor(() => expect(guest.updates.at(-1)?.quest_prize).toBe(prize), { timeout: 5000 });
    } finally {
      guest.close();
    }
  });

  it('returns to the default when the host clears it', async () => {
    const host = await newHost();
    await updateEvent(host, { questPrize: 'Champagne' });

    const res = await updateEvent(host, { questPrize: null });

    expect(res.status).toBe(200);
    expect(await publicPrize(host)).toBeNull();
  });

  it('survives an unrelated settings change', async () => {
    const host = await newHost();
    await updateEvent(host, { questPrize: 'Champagne' });

    // The update handler writes only the keys present in the body; a prize
    // wiped by every venue edit would pass every other test in this file.
    await updateEvent(host, { venueName: 'Spec Castle' });

    expect(await publicPrize(host)).toBe('Champagne');
  });

  it('accepts exactly 500 characters and refuses 501', async () => {
    const host = await newHost();

    const atCap = await updateEvent(host, { questPrize: 'x'.repeat(500) });
    expect(atCap.status).toBe(200);

    const overCap = await updateEvent(host, { questPrize: 'y'.repeat(501) });
    expect(overCap.status).toBe(400);

    // Refused outright, not truncated or half-written.
    expect(await publicPrize(host)).toBe('x'.repeat(500));
  });

  it('refuses a prize that is not a string', async () => {
    const host = await newHost();

    const res = await updateEvent(host, { questPrize: { html: '<b>win</b>' } });

    expect(res.status).toBe(400);
    expect(await publicPrize(host)).toBeNull();
  });

  describe('the TV-wall leaderboard switch', () => {
    async function publicSwitch(host: Session): Promise<unknown> {
      const res = await fetch(`${BASE_URL}/api/events/slug/${encodeURIComponent(host.slug)}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('show_tv_leaderboard');
      return body.show_tv_leaderboard;
    }

    it('is off for a new event, so the wall shows photos only', async () => {
      const host = await newHost();

      expect(await publicSwitch(host)).toBe(false);
    });

    it('reaches the wall on load and live when the host switches it on, and off again', async () => {
      const host = await newHost();
      const wall = await joinAsGuest(host.eventId);

      try {
        expect((await updateEvent(host, { showTvLeaderboard: true })).status).toBe(200);
        expect(await publicSwitch(host)).toBe(true);
        await vi.waitFor(() => expect(wall.updates.at(-1)?.show_tv_leaderboard).toBe(true), { timeout: 5000 });

        // Off must travel as well as on: a false dropped on the way would
        // leave the board on a wall the host has just cleared.
        expect((await updateEvent(host, { showTvLeaderboard: false })).status).toBe(200);
        expect(await publicSwitch(host)).toBe(false);
        await vi.waitFor(() => expect(wall.updates.at(-1)?.show_tv_leaderboard).toBe(false), { timeout: 5000 });
      } finally {
        wall.close();
      }
    });

    it('refuses anything but a boolean', async () => {
      const host = await newHost();

      expect((await updateEvent(host, { showTvLeaderboard: 'yes' })).status).toBe(400);
      expect(await publicSwitch(host)).toBe(false);
    });
  });
});
