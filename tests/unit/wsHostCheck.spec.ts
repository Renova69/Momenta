import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import { wsManager } from '../../server/ws/wsServer';
import { pool, query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-82 — the WebSocket host check caches its answer for a minute, so a
 * reconnect storm does not re-ask the database. A database error was cached
 * the same way, as "not the host": one blip, and the host's moderation queue
 * and host-only updates stayed dark for the next minute on every join.
 */

const createdEvents: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
});

/** The private check, reached directly: the join that calls it needs a live socket. */
const isEventHost = (userId: string, eventId: string): Promise<boolean> =>
  (wsManager as unknown as { isEventHost(u: string, e: string): Promise<boolean> }).isEventHost(userId, eventId);

async function hostAndAlbum(): Promise<{ userId: string; eventId: string }> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'WS Host', 'x', 'couple') RETURNING id`,
    [`ws-host-${tag}@test.com`]
  );
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, host_user_id)
     VALUES ($1, 'WS Host Spec', 'Spec Host', 'ws@test.local', CURRENT_DATE, $2) RETURNING id`,
    [`ws-host-${tag}`, user.rows[0].id]
  );
  createdEvents.push(event.rows[0].id);
  return { userId: user.rows[0].id, eventId: event.rows[0].id };
}

describe('the WebSocket host check (N-82)', () => {
  it('does not remember a database error as "not the host"', async () => {
    const { userId, eventId } = await hostAndAlbum();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const blip = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('connection terminated'));

    expect(await isEventHost(userId, eventId)).toBe(false);
    blip.mockRestore();

    expect(await isEventHost(userId, eventId)).toBe(true);
  });

  it('still remembers a real answer', async () => {
    const { userId, eventId } = await hostAndAlbum();
    expect(await isEventHost(userId, eventId)).toBe(true);
    const lookups = vi.spyOn(pool, 'query');

    expect(await isEventHost(userId, eventId)).toBe(true);
    expect(lookups).not.toHaveBeenCalled();
  });
});
