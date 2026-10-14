import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-109 — disposable camera mode revealed every photo straight away.
 *
 * The host's toggle wrote `is_disposable_mode` and nothing else. Nothing in
 * the app ever set `reveal_at`, and every place that hides a locked photo asks
 * whether `reveal_at` is still ahead — so with it NULL the album counted as
 * already revealed. Uploads were marked locked, the guest was told the photo
 * would be revealed the morning after, and the feed published it to everyone.
 *
 * Switching the mode on now sets the reveal to what the toggle promises: 09:00
 * in Sofia, the morning after the wedding. Switching it off clears it, and a
 * wedding moved later than its reveal takes the reveal with it.
 */

const TEST_PORT = 6674;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

interface Host {
  token: string;
  eventId: string;
}

async function deluxeHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `reveal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Reveal Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [data.user.id]);
  return { token: data.token, eventId: data.event.id };
}

function update(host: Host, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/events/${host.eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify(body),
  });
}

async function revealAt(eventId: string): Promise<Date | null> {
  const { rows } = await query<{ reveal_at: Date | null }>('SELECT reveal_at FROM events WHERE id = $1', [eventId]);
  return rows[0].reveal_at;
}

/** 09:00 in Sofia on the day after `date`'s Sofia calendar day, as an instant. */
function morningAfterInSofia(date: string): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date(date));
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toISOString().slice(0, 10);
  // Sofia is UTC+2 in winter and UTC+3 in summer; find the offset that day.
  for (const offset of ['+02:00', '+03:00']) {
    const candidate = new Date(`${nextDay}T09:00:00${offset}`);
    const shown = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Sofia',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(candidate);
    if (shown === '09:00') return candidate.toISOString();
  }
  throw new Error('no Sofia offset matched');
}

async function uploadAsGuest(eventId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Reveal Spec Guest',
      deviceFingerprint: `reveal-${Math.random().toString(36).slice(2, 10)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/photos', photosRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

  const jpeg = await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 90, g: 60, b: 160 } } })
    .jpeg()
    .toBuffer();
  jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  if (server) server.close();
});

describe('disposable camera mode keeps photos hidden until the morning after (N-109)', () => {
  it('sets the reveal to 09:00 in Sofia the morning after the wedding when switched on', async () => {
    const host = await deluxeHost();
    await update(host, { eventDate: '2027-06-12T16:30:00.000Z' });

    const res = await update(host, { isDisposableMode: true });

    expect(res.status).toBe(200);
    expect((await revealAt(host.eventId))?.toISOString()).toBe(morningAfterInSofia('2027-06-12T16:30:00.000Z'));
    expect(new Date((await res.json()).reveal_at).toISOString()).toBe(morningAfterInSofia('2027-06-12T16:30:00.000Z'));
  });

  it('hides a photo taken in disposable mode from other guests until then', async () => {
    const host = await deluxeHost();
    await update(host, { eventDate: '2027-06-12T16:30:00.000Z' });
    await update(host, { isDisposableMode: true });

    const photoId = await uploadAsGuest(host.eventId);

    const feed = await (await fetch(`${BASE_URL}/api/photos?eventId=${host.eventId}`)).json();
    expect(feed.map((p: { id: string }) => p.id)).not.toContain(photoId);
  });

  it('keeps a reveal time the host chose', async () => {
    const host = await deluxeHost();
    const chosen = '2027-07-01T18:00:00.000Z';

    await update(host, { isDisposableMode: true, revealAt: chosen });

    expect((await revealAt(host.eventId))?.toISOString()).toBe(chosen);
  });

  it('clears the reveal when switched off, so switching on again starts afresh', async () => {
    const host = await deluxeHost();
    await update(host, { isDisposableMode: true });

    await update(host, { isDisposableMode: false });

    expect(await revealAt(host.eventId)).toBeNull();
  });

  it('moves the reveal when the wedding is moved later than it', async () => {
    const host = await deluxeHost();
    await update(host, { eventDate: '2027-06-12T16:30:00.000Z' });
    await update(host, { isDisposableMode: true });

    await update(host, { eventDate: '2027-08-20T15:00:00.000Z' });

    expect((await revealAt(host.eventId))?.toISOString()).toBe(morningAfterInSofia('2027-08-20T15:00:00.000Z'));
  });

  it('leaves the reveal alone when the wedding moves but stays before it', async () => {
    const host = await deluxeHost();
    await update(host, { eventDate: '2027-06-12T16:30:00.000Z' });
    const chosen = '2027-09-01T07:00:00.000Z';
    await update(host, { isDisposableMode: true, revealAt: chosen });

    await update(host, { eventDate: '2027-06-13T16:30:00.000Z' });

    expect((await revealAt(host.eventId))?.toISOString()).toBe(chosen);
  });
});
