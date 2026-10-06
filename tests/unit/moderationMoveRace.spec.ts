import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import { storageAdapter, toStoragePath } from '../../server/lib/storage';
import { promotePhotoFromQuarantine, withholdPhotoToQuarantine } from '../../server/lib/photoQuarantine';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-71 — approving a photo moves its files out of quarantine, and rejecting
 * it moves them back. The two never coordinated: each read the row once, at
 * the start. A host who rejected a photo while its approval's promotion was
 * still moving files got a withhold that saw "still quarantined" and did
 * nothing; the promotion then finished, and the photo the host had just
 * rejected was public. The reverse, a slow withhold landing after a newer
 * approval, hid a photo the host wanted shown.
 *
 * Moves of one photo now take a lock of their own, and each decides from the
 * status as it is once it holds the lock.
 */

const createdEvents: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
});

async function photo(options: { status: string; quarantined: boolean }): Promise<string> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const event = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date)
     VALUES ($1, 'N-71 Spec', 'Spec Host', 'n71@test.local', CURRENT_DATE) RETURNING id`,
    [`n71-${tag}`]
  );
  const eventId = event.rows[0].id;
  createdEvents.push(eventId);
  const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'G') RETURNING id`, [
    eventId,
  ]);
  const [display, original, thumb] = await Promise.all(
    ['display', 'original', 'thumb'].map((v) =>
      storageAdapter.save(Buffer.from(v), `${v}-${tag}.jpg`, 'image/jpeg', eventId, {
        quarantine: options.quarantined,
      })
    )
  );
  const row = await query<{ id: string }>(
    `INSERT INTO photos (event_id, guest_id, storage_path, full_url, original_storage_path, original_url,
                         thumbnail_url, status, is_quarantined, storage_bytes)
     VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7, 0) RETURNING id`,
    [eventId, guest.rows[0].id, display.storagePath, original.storagePath, thumb.storagePath, options.status, options.quarantined]
  );
  return row.rows[0].id;
}

/** Where the photo's files are, according to its row, and whether they are really there. */
async function filesOf(photoId: string): Promise<{ quarantined: boolean; paths: string[]; allOnDisk: boolean }> {
  const { rows } = await query<{
    storage_path: string;
    original_storage_path: string;
    thumbnail_url: string;
    is_quarantined: boolean;
  }>('SELECT storage_path, original_storage_path, thumbnail_url, is_quarantined FROM photos WHERE id = $1', [photoId]);
  const paths = [rows[0].storage_path, rows[0].original_storage_path, toStoragePath(rows[0].thumbnail_url) ?? ''];
  const allOnDisk = paths.every((p) => {
    const abs = storageAdapter.getAbsolutePath(p);
    return !!abs && fs.existsSync(abs);
  });
  return { quarantined: rows[0].is_quarantined, paths, allOnDisk };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a rejection while the approval is still moving files (N-71)', () => {
  it('leaves the rejected photo behind quarantine', async () => {
    const photoId = await photo({ status: 'approved', quarantined: true });

    // Hold the approval's first file move until the rejection has been made.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = storageAdapter.promoteFromQuarantine.bind(storageAdapter);
    let first = true;
    vi.spyOn(storageAdapter, 'promoteFromQuarantine').mockImplementation(async (p: string) => {
      if (first) {
        first = false;
        await gate;
      }
      return real(p);
    });

    const approval = promotePhotoFromQuarantine(photoId);
    await sleep(100);

    // The host rejects it: the route writes the status, then withholds.
    await query("UPDATE photos SET status = 'rejected' WHERE id = $1", [photoId]);
    const rejection = withholdPhotoToQuarantine(photoId);
    // Long enough for a withhold that does not wait to have finished.
    await Promise.race([rejection, sleep(300)]);
    release();
    await Promise.all([approval, rejection]);

    const after = await filesOf(photoId);
    expect(after.quarantined).toBe(true);
    for (const p of after.paths) expect(p).toContain('/quarantine/');
    expect(after.allOnDisk).toBe(true);
  });

  it('does not publish a photo rejected before its promotion began', async () => {
    // The approval's request decided to promote, then lost the race to the
    // rejection's status write.
    const photoId = await photo({ status: 'rejected', quarantined: true });

    await promotePhotoFromQuarantine(photoId);

    const after = await filesOf(photoId);
    expect(after.quarantined).toBe(true);
    for (const p of after.paths) expect(p).toContain('/quarantine/');
  });

  it('does not hide a photo approved again before an older withhold ran', async () => {
    // A rejection's withhold arriving after the host changed their mind.
    const photoId = await photo({ status: 'approved', quarantined: false });

    await withholdPhotoToQuarantine(photoId);

    const after = await filesOf(photoId);
    expect(after.quarantined).toBe(false);
    for (const p of after.paths) expect(p).toMatch(/^\/uploads\//);
    expect(after.allOnDisk).toBe(true);
  });
});
