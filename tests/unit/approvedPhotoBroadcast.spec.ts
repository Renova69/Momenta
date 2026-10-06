import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { WebSocket } from 'ws';
import sharp from 'sharp';

import { photosRouter } from '../../server/routes/photos';
import { wsManager } from '../../server/ws/wsServer';
import { query } from '../../server/lib/db';
import { generateToken } from '../../server/middleware/auth';
import { storageAdapter } from '../../server/lib/storage';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-67 — a photo approved from the moderation queue never reached a guest's
 * screen, or the projector wall, until a reload. Approval broadcast only
 * `{ photoId, status }`, and a guest has nothing to apply a status to: the
 * photo was pending when it arrived, so the guest was never sent it.
 *
 * N-92 — the live broadcast of a new photo went to the whole room with its
 * `originalUrl`: the untouched camera file, EXIF and GPS included. The REST
 * feed withholds it from everyone but the host (MED-02); the socket did not.
 *
 * Hosts are made in SQL, not through POST /api/auth/register, whose limiter
 * allows 25 accounts per address per 15 minutes.
 */

let baseUrl = '';
let wsUrl = '';
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

interface Host {
  token: string;
  eventId: string;
}

async function createHost(options: { moderated: boolean }): Promise<Host> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await query<{ id: string; email: string; role: string; full_name: string }>(
    `INSERT INTO users (email, full_name, password_hash, role)
     VALUES ($1, 'Approval Spec Host', 'x', 'couple') RETURNING id, email, role, full_name`,
    [`approval-${tag}@test.com`]
  );
  const u = user.rows[0];
  await query(
    `INSERT INTO subscriptions (user_id, tier, status, billing_type, amount_paid_cents, currency, event_limit)
     VALUES ($1, 'celebration_pass', 'active', 'one_time', 0, 'EUR', 1)`,
    [u.id]
  );
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, host_user_id, is_moderation_enabled)
     VALUES ($1, 'Approval Spec', 'Spec Host', $2, CURRENT_DATE, $3, $4) RETURNING id`,
    [`approval-${tag}`, u.email, u.id, options.moderated]
  );
  createdEvents.push(event.rows[0].id);
  const token = generateToken({ userId: u.id, email: u.email, role: u.role, fullName: u.full_name, tokenVersion: 0 });
  return { token, eventId: event.rows[0].id };
}

/** A WebSocket client that has joined an event room and records what it receives. */
class RoomClient {
  readonly received: { type: string; payload: Record<string, unknown> }[] = [];
  private ws!: WebSocket;
  isHost = false;

  static async join(eventId: string, hostToken?: string): Promise<RoomClient> {
    const client = new RoomClient();
    client.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket join timed out')), 5000);
      client.ws.on('open', () => {
        if (hostToken) client.ws.send(JSON.stringify({ type: 'AUTH', token: hostToken }));
        client.ws.send(JSON.stringify({ type: 'JOIN_EVENT_ROOM', eventId }));
      });
      client.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ROOM_JOINED') {
          client.isHost = !!msg.isHost;
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (msg.type !== 'CONNECTED') client.received.push({ type: msg.type, payload: msg.payload || {} });
      });
      client.ws.on('error', reject);
    });
    return client;
  }

  of(type: string) {
    return this.received.filter((m) => m.type === type);
  }

  close() {
    this.ws.close();
  }
}

const arrives = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000 });

async function uploadPhoto(eventId: string, caption: string): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Spec Guest',
      deviceFingerprint: `approval-fp-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
      originalUrl: jpegDataUrl,
      caption,
    }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function setStatus(host: Host, photoId: string, status: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/photos/${photoId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify({ status }),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  wsManager.init(server);
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/photos', photosRouter);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;
  wsUrl = `ws://localhost:${port}`;

  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 140, b: 200 } } })
    .jpeg()
    .toBuffer();
  jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
});

afterAll(async () => {
  wsManager.shutdown();
  await deleteEventFixtures(createdEvents);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a photo the host approves (N-67)', () => {
  it('reaches the guests already watching, with images they can load', async () => {
    const host = await createHost({ moderated: true });
    const { id } = await uploadPhoto(host.eventId, 'approved live');
    const guest = await RoomClient.join(host.eventId);

    await setStatus(host, id, 'approved');

    await arrives(() => expect(guest.of('PHOTO_ADDED')).toHaveLength(1));
    const sent = guest.of('PHOTO_ADDED')[0].payload;
    expect(sent.id).toBe(id);
    expect(sent.status).toBe('approved');
    expect(sent.caption).toBe('approved live');
    expect(sent.fullUrl).toBeTruthy();
    expect(String(sent.fullUrl)).not.toContain('quarantine');
    expect(String(sent.thumbnailUrl)).not.toContain('quarantine');
    expect(sent.originalUrl).toBeNull();
    guest.close();
  });

  it('is not sent again to the host, who has held it since it arrived', async () => {
    const host = await createHost({ moderated: true });
    const { id } = await uploadPhoto(host.eventId, 'host already has it');
    const hostClient = await RoomClient.join(host.eventId, host.token);
    expect(hostClient.isHost).toBe(true);

    await setStatus(host, id, 'approved');

    await arrives(() => expect(hostClient.of('PHOTO_STATUS_UPDATED')).toHaveLength(1));
    expect(hostClient.of('PHOTO_ADDED')).toHaveLength(0);
    hostClient.close();
  });

  it('is not announced again when an approved photo is featured', async () => {
    const host = await createHost({ moderated: true });
    const { id } = await uploadPhoto(host.eventId, 'approved then featured');
    await setStatus(host, id, 'approved');
    const guest = await RoomClient.join(host.eventId);

    await setStatus(host, id, 'featured');

    await arrives(() => expect(guest.of('PHOTO_STATUS_UPDATED')).toHaveLength(1));
    expect(guest.of('PHOTO_ADDED')).toHaveLength(0);
    guest.close();
  });

  it('is not sent to guests when the host rejects it instead', async () => {
    const host = await createHost({ moderated: true });
    const { id } = await uploadPhoto(host.eventId, 'rejected, stays hidden');
    const guest = await RoomClient.join(host.eventId);

    await setStatus(host, id, 'rejected');

    await arrives(() => expect(guest.of('PHOTO_STATUS_UPDATED')).toHaveLength(1));
    expect(guest.of('PHOTO_ADDED')).toHaveLength(0);
    guest.close();
  });

  it('is held back from guests while its files could not be moved out of quarantine', async () => {
    // Promotion failing is logged and the approval still stands; a guest sent
    // the photo now would get images that cannot load.
    const host = await createHost({ moderated: true });
    const { id } = await uploadPhoto(host.eventId, 'promotion failed');
    const guest = await RoomClient.join(host.eventId);
    const promote = vi.spyOn(storageAdapter, 'promoteFromQuarantine').mockRejectedValue(new Error('storage down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await setStatus(host, id, 'approved');
    } finally {
      promote.mockRestore();
    }

    await arrives(() => expect(guest.of('PHOTO_STATUS_UPDATED')).toHaveLength(1));
    expect(guest.of('PHOTO_ADDED')).toHaveLength(0);
    guest.close();
  });

  it('reaches guests without its images while the album is still before its reveal', async () => {
    const host = await createHost({ moderated: true });
    await query("UPDATE events SET is_disposable_mode = true, reveal_at = NOW() + INTERVAL '1 hour' WHERE id = $1", [
      host.eventId,
    ]);
    const { id } = await uploadPhoto(host.eventId, 'approved but locked');
    await query('UPDATE photos SET is_locked = true WHERE id = $1', [id]);
    const guest = await RoomClient.join(host.eventId);

    await setStatus(host, id, 'approved');

    await arrives(() => expect(guest.of('PHOTO_ADDED')).toHaveLength(1));
    const sent = guest.of('PHOTO_ADDED')[0].payload;
    expect(sent.isLocked).toBe(true);
    expect(sent.fullUrl).toBe('');
    expect(sent.thumbnailUrl).toBe('');
    expect(sent.originalUrl).toBeNull();
    guest.close();
  });
});

describe('the camera original in a live broadcast (N-92)', () => {
  it('goes to the host but not to the guests', async () => {
    const host = await createHost({ moderated: false });
    const guest = await RoomClient.join(host.eventId);
    const hostClient = await RoomClient.join(host.eventId, host.token);

    await uploadPhoto(host.eventId, 'with an original');

    await arrives(() => {
      expect(guest.of('PHOTO_ADDED')).toHaveLength(1);
      expect(hostClient.of('PHOTO_ADDED')).toHaveLength(1);
    });
    expect(guest.of('PHOTO_ADDED')[0].payload.originalUrl).toBeNull();
    expect(hostClient.of('PHOTO_ADDED')[0].payload.originalUrl).toBeTruthy();
    guest.close();
    hostClient.close();
  });
});
