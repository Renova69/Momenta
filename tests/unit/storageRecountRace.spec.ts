import { describe, it, expect, afterAll } from 'vitest';
import { reseedEventTotals } from '../../scripts/storage-recount';
import { pool, query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-89 — `storage:recount` reseeded every album's total in one UPDATE whose
 * sums came from the snapshot it started with. An upload whose trigger had
 * already raised the album's total, and which committed while the reseed
 * waited for that row, was then overwritten by a sum that did not include it:
 * the album held more than its total said, and the plan's limit was measured
 * against the smaller number.
 *
 * Each album is now reseeded on its own, its row locked first and the sum
 * taken afterwards.
 */

const createdEvents: string[] = [];

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
});

async function albumHolding(bytes: number): Promise<{ eventId: string; guestId: string }> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date)
     VALUES ($1, 'Recount Spec', 'Spec Host', 'recount@test.local', CURRENT_DATE) RETURNING id`,
    [`recount-${tag}`]
  );
  const eventId = event.rows[0].id;
  createdEvents.push(eventId);
  const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'G') RETURNING id`, [
    eventId,
  ]);
  await query(
    `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes)
     VALUES ($1, $2, '/uploads/r-0.jpg', '/uploads/r-0.jpg', 'approved', $3)`,
    [eventId, guest.rows[0].id, bytes]
  );
  return { eventId, guestId: guest.rows[0].id };
}

async function totalOf(eventId: string): Promise<number> {
  const { rows } = await query<{ b: string }>('SELECT storage_bytes AS b FROM events WHERE id = $1', [eventId]);
  return Number(rows[0].b);
}

describe('reseeding an album total while an upload is committing (N-89)', () => {
  it('counts the upload', async () => {
    const { eventId, guestId } = await albumHolding(100);
    expect(await totalOf(eventId)).toBe(100);

    // An upload, its row written and its trigger run, not yet committed.
    const upload = await pool.connect();
    try {
      await upload.query('BEGIN');
      await upload.query(
        `INSERT INTO photos (event_id, guest_id, storage_path, full_url, status, storage_bytes)
         VALUES ($1, $2, '/uploads/r-1.jpg', '/uploads/r-1.jpg', 'approved', 50)`,
        [eventId, guestId]
      );

      const reseed = reseedEventTotals([eventId]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await upload.query('COMMIT');
      await reseed;
    } finally {
      upload.release();
    }

    expect(await totalOf(eventId)).toBe(150);
  });

  it('counts a photo deleted while it reseeds as gone', async () => {
    const { eventId } = await albumHolding(100);

    const removal = await pool.connect();
    try {
      await removal.query('BEGIN');
      await removal.query('DELETE FROM photos WHERE event_id = $1', [eventId]);

      const reseed = reseedEventTotals([eventId]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await removal.query('COMMIT');
      await reseed;
    } finally {
      removal.release();
    }

    expect(await totalOf(eventId)).toBe(0);
  });

  it('corrects a total that had drifted', async () => {
    const { eventId } = await albumHolding(100);
    await query('UPDATE events SET storage_bytes = 999 WHERE id = $1', [eventId]);

    await reseedEventTotals([eventId]);

    expect(await totalOf(eventId)).toBe(100);
  });
});
