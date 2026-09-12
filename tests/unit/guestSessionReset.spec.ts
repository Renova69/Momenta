import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { guestsRouter } from '../../server/routes/guests';
import { query } from '../../server/lib/db';

/**
 * M10 — guest tokens could not be revoked.
 *
 * A guest token is a bearer credential with a 400-day TTL, and that TTL is
 * justified: a Deluxe album lives a year, and a guest reopening the link weeks
 * later should not be treated as a stranger. The problem was that nothing
 * could ever end one. A token copied off a shared phone, or pulled out of a
 * screenshot, stayed valid for the life of the album with no way for the host
 * to do anything about it — `users.token_version` (migration 019) had no
 * `guests` equivalent because there is no guest logout to bump it.
 *
 * The trigger this needed is a host action, not a guest one: "reset guest
 * sessions" on the album the host controls. Migration 023 adds
 * `guests.token_version`, and the reset does two things together:
 *
 *   1. bumps the version, killing every token already issued;
 *   2. clears `device_fingerprint`, releasing the (event_id, fingerprint)
 *      slot.
 *
 * The second is what makes the first recoverable without breaking SEC-03.
 * A returning guest re-joins, no longer matches an existing row, gets a
 * genuinely fresh one, and is issued a token because that row is inherently
 * theirs. Without it a reset would be permanent: the fingerprint would still
 * match an old row, `xmax = 0` would be false, and no token could ever be
 * issued again — while issuing one on a fingerprint match is exactly the hole
 * SEC-03 exists to keep shut.
 *
 * The cost is real and deliberate: the old guest row keeps its photos, so a
 * guest who re-joins after a reset is a new identity and loses the link to
 * what they uploaded before. That is the price of revocation here, and it is
 * a decision the host takes knowingly.
 */

const TEST_PORT = 6639;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
}

async function registerHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `greset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Guest Reset Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

async function joinAsGuest(eventId: string, fingerprint: string) {
  const res = await fetch(`${BASE_URL}/api/guests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, name: 'Reset Spec Guest', deviceFingerprint: fingerprint }),
  });
  return res.json() as Promise<{ id: string; guestToken?: string }>;
}

async function uploadPhoto(eventId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Reset Spec Guest',
      deviceFingerprint: `reset-owner-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  return (await res.json()).id as string;
}

function like(photoId: string, guestId: string, guestToken?: string) {
  return fetch(`${BASE_URL}/api/photos/${photoId}/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guestId, guestToken }),
  });
}

function resetGuestSessions(host: Host, token = host.token) {
  return fetch(`${BASE_URL}/api/events/${host.eventId}/guest-sessions/reset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('host can revoke guest sessions (M10)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/guests', guestsRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 150, g: 180, b: 210 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    if (server) server.close();
  });

  it('kills a token that was working a moment earlier', async () => {
    const host = await registerHost();
    const photoId = await uploadPhoto(host.eventId);
    const guest = await joinAsGuest(host.eventId, `fp-kill-${Math.random().toString(36).slice(2, 8)}`);
    expect(guest.guestToken).toBeTruthy();

    expect((await like(photoId, guest.id, guest.guestToken)).status).toBe(200);

    const reset = await resetGuestSessions(host);
    expect(reset.status).toBe(200);

    const after = await like(photoId, guest.id, guest.guestToken);
    expect(after.status).toBe(401);
  });

  it('lets a returning guest join again and get a usable token', async () => {
    const host = await registerHost();
    const photoId = await uploadPhoto(host.eventId);
    const fingerprint = `fp-rejoin-${Math.random().toString(36).slice(2, 8)}`;
    const before = await joinAsGuest(host.eventId, fingerprint);

    await resetGuestSessions(host);

    // Same device, same fingerprint. The slot was released, so this is a fresh
    // identity rather than a match onto the old row — which is what allows a
    // token to be issued at all without reopening SEC-03.
    const after = await joinAsGuest(host.eventId, fingerprint);
    expect(after.guestToken).toBeTruthy();
    expect(after.id).not.toBe(before.id);

    expect((await like(photoId, after.id, after.guestToken)).status).toBe(200);
  });

  it('keeps the photos the old guest identity uploaded', async () => {
    const host = await registerHost();
    const fingerprint = `fp-keep-${Math.random().toString(36).slice(2, 8)}`;
    await joinAsGuest(host.eventId, fingerprint);
    await uploadPhoto(host.eventId);

    const countBefore = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM photos WHERE event_id = $1',
      [host.eventId]
    );

    await resetGuestSessions(host);

    const countAfter = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM photos WHERE event_id = $1',
      [host.eventId]
    );
    expect(countAfter.rows[0].n).toBe(countBefore.rows[0].n);
    expect(countAfter.rows[0].n).toBeGreaterThan(0);
  });

  it('reports how many sessions it ended', async () => {
    const host = await registerHost();
    await joinAsGuest(host.eventId, `fp-count-a-${Math.random().toString(36).slice(2, 8)}`);
    await joinAsGuest(host.eventId, `fp-count-b-${Math.random().toString(36).slice(2, 8)}`);

    const res = await resetGuestSessions(host);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.guestsReset).toBeGreaterThanOrEqual(2);
  });

  it('does not touch another event', async () => {
    const hostA = await registerHost();
    const hostB = await registerHost();
    const photoB = await uploadPhoto(hostB.eventId);
    const guestB = await joinAsGuest(hostB.eventId, `fp-other-${Math.random().toString(36).slice(2, 8)}`);

    await resetGuestSessions(hostA);

    expect((await like(photoB, guestB.id, guestB.guestToken)).status).toBe(200);
  });

  it('refuses a host who does not own the event, and an anonymous caller', async () => {
    const owner = await registerHost();
    const stranger = await registerHost();

    expect((await resetGuestSessions(owner, stranger.token)).status).toBe(403);

    const anon = await fetch(`${BASE_URL}/api/events/${owner.eventId}/guest-sessions/reset`, { method: 'POST' });
    expect(anon.status).toBe(401);
  });

  it('treats a token minted before the column existed as version 0', async () => {
    // Backward compatibility, the same way migration 019 handled it for hosts:
    // tokens issued before this carry no version and must keep working until
    // an actual reset, not break on deploy.
    const host = await registerHost();
    const photoId = await uploadPhoto(host.eventId);
    const guest = await joinAsGuest(host.eventId, `fp-legacy-${Math.random().toString(36).slice(2, 8)}`);

    const stored = await query<{ token_version: number }>('SELECT token_version FROM guests WHERE id = $1', [
      guest.id,
    ]);
    expect(Number(stored.rows[0].token_version)).toBe(0);
    expect((await like(photoId, guest.id, guest.guestToken)).status).toBe(200);
  });
});
