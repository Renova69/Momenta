import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-117 — every Bulgarian poster printed English.
 *
 * With no saved QR config the server answered with "Capture the Love" and an
 * English instruction, and the studio prefers what the server sends over its
 * own translated default, so the poster a host printed for the tables said
 * "Scan the QR code with your phone camera…". A save that changed only the
 * headline stored the English instruction too, and so did the column default.
 *
 * Text the host did not write is now left empty, and the studio fills it in
 * the language it is showing.
 */

const TEST_PORT = 6676;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

async function celebrationHost(): Promise<{ token: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `qrdefaults-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'QR Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  await query("UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = $1", [data.user.id]);
  return { token: data.token, eventId: data.event.id };
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  if (server) server.close();
});

describe('poster text the host did not write (N-117)', () => {
  it('is left empty when nothing has been saved', async () => {
    const host = await celebrationHost();

    const config = await (await fetch(`${BASE_URL}/api/events/${host.eventId}/qr-config`)).json();

    expect(config.headline ?? '').toBe('');
    expect(config.subtext ?? '').toBe('');
  });

  it('stays empty when the host saves only the headline', async () => {
    const host = await celebrationHost();

    const res = await fetch(`${BASE_URL}/api/events/${host.eventId}/qr-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ headline: 'Уловете любовта' }),
    });

    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved.headline).toBe('Уловете любовта');
    expect(saved.subtext ?? '').toBe('');
  });

  it('is never English text the host did not choose, at the column either', async () => {
    const host = await celebrationHost();

    await query('INSERT INTO qr_canvas_configs (event_id) VALUES ($1)', [host.eventId]);

    const { rows } = await query('SELECT headline, subtext FROM qr_canvas_configs WHERE event_id = $1', [host.eventId]);
    expect(rows[0].headline).toBeNull();
    expect(rows[0].subtext).toBeNull();
  });
});
