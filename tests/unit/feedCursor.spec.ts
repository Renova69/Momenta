import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';

import { photosRouter } from '../../server/routes/photos';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-88 — the feed is paged by (priority, created_at), and the next page was
 * asked for with the last photo's createdAt as JSON carries it: to the
 * millisecond. The rows are stored to the microsecond. Every other photo
 * stored in the same millisecond as a page's last one fell between the pages
 * and was never shown; two photos stored in the same microsecond, as a burst
 * of FTP frames can be, could not be told apart at all.
 *
 * The feed now hands each photo the cursor to continue after it: microsecond
 * time, and the photo id to break ties.
 */

let baseUrl = '';
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use('/api/photos', photosRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** An album whose photos were all stored within one millisecond. */
async function albumWithinOneMillisecond(stamps: string[]): Promise<{ eventId: string; ids: string[] }> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date)
     VALUES ($1, 'Cursor Spec', 'Spec Host', 'cursor@test.local', CURRENT_DATE) RETURNING id`,
    [`cursor-${tag}`]
  );
  const eventId = event.rows[0].id;
  createdEvents.push(eventId);
  const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'G') RETURNING id`, [
    eventId,
  ]);
  const ids: string[] = [];
  for (const [i, stamp] of stamps.entries()) {
    const photo = await query<{ id: string }>(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes, created_at)
       VALUES ($1, $2, $3, $3, 'approved', 0, $4::timestamptz) RETURNING id`,
      [eventId, guest.rows[0].id, `/uploads/events/${eventId}/c-${i}.jpg`, stamp]
    );
    ids.push(photo.rows[0].id);
  }
  return { eventId, ids };
}

/** Walk every page, one photo per page, the way the app does. */
async function walk(eventId: string): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = `${baseUrl}/api/photos?eventId=${eventId}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const batch = (await res.json()) as { id: string; pageCursor: string }[];
    if (batch.length === 0) break;
    seen.push(batch[0].id);
    cursor = batch[0].pageCursor;
  }
  return seen;
}

describe('paging through photos stored close together (N-88)', () => {
  it('shows every photo stored within the same millisecond', async () => {
    const { eventId, ids } = await albumWithinOneMillisecond([
      '2026-06-20T18:00:00.123100Z',
      '2026-06-20T18:00:00.123200Z',
      '2026-06-20T18:00:00.123300Z',
    ]);

    const seen = await walk(eventId);

    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('shows every photo stored in the same microsecond', async () => {
    const { eventId, ids } = await albumWithinOneMillisecond([
      '2026-06-20T18:00:00.500000Z',
      '2026-06-20T18:00:00.500000Z',
      '2026-06-20T18:00:00.500000Z',
    ]);

    const seen = await walk(eventId);

    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('still accepts the cursor older apps send', async () => {
    const { eventId } = await albumWithinOneMillisecond(['2026-06-20T18:00:01.000000Z']);

    const res = await fetch(
      `${baseUrl}/api/photos?eventId=${eventId}&limit=1&cursor=${encodeURIComponent('0:2026-06-20T18:00:02.000Z')}`
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it('refuses a cursor that is not one', async () => {
    const { eventId } = await albumWithinOneMillisecond(['2026-06-20T18:00:01.000000Z']);

    const res = await fetch(`${baseUrl}/api/photos?eventId=${eventId}&cursor=${encodeURIComponent('0:yesterday')}`);

    expect(res.status).toBe(400);
  });
});
