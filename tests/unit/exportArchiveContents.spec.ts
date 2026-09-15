import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import fs from 'fs';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { pool, query } from '../../server/lib/db';
import { storageAdapter } from '../../server/lib/storage';
import { CONFIG } from '../../server/lib/config';

const TEST_PORT = 6645;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

/**
 * What actually ends up inside the exported archive.
 *
 * `exportDownload.spec.ts` covers the credential and the transport — who may
 * mint a ticket, that the stream starts, that store mode is used, that a
 * disconnect stops the work. This covers the file selection underneath it,
 * which is where the export is a security boundary rather than a feature:
 * `photos.storage_path` is a column, and a column is untrusted input at rest.
 * If a row for this album can name an object belonging to a different one,
 * the host of album A downloads a zip containing album B's wedding — and gets
 * no error, because from the outside a successful download looks the same
 * either way. The only way to see it is to read the entry names back out.
 *
 * A stored (uncompressed) zip carries each entry name verbatim in its local
 * file header, so the names can be read straight out of the response bytes
 * without decoding the container.
 */

interface Host {
  token: string;
  userId: string;
  eventId: string;
}

async function registerHost(): Promise<Host> {
  const email = `archive-spec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Archive Spec Host', password: 'Password123!' }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

async function downloadArchive(host: Host): Promise<Buffer> {
  const ticketRes = await fetch(`${BASE_URL}/api/events/${host.eventId}/export-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}` },
  });
  const { token } = await ticketRes.json();

  const res = await fetch(
    `${BASE_URL}/api/events/${host.eventId}/export-zip?token=${encodeURIComponent(token)}`
  );
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

/** Write a real file into an event's storage and return its stored path. */
async function saveFile(eventId: string, name: string): Promise<string> {
  const saved = await storageAdapter.save(
    Buffer.from('x'.repeat(512)),
    name,
    'image/jpeg',
    eventId
  );
  return saved.storagePath;
}

async function addGuest(eventId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO guests (event_id, name) VALUES ($1, 'Archive Spec Guest') RETURNING id`,
    [eventId]
  );
  return rows[0].id;
}

let mine: Host;
let theirs: Host;
let archive: Buffer;

// File-level, not per-describe: the server has to outlive the first block.
beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

  mine = await registerHost();
  theirs = await registerHost();
  await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [mine.userId]);

  const guest = await addGuest(mine.eventId);

  // A photo kept in both resolutions. The export must prefer the original.
  const display = await saveFile(mine.eventId, 'kept-display.jpg');
  const original = await saveFile(mine.eventId, 'kept-original.jpg');

  // A photo from before originals were retained (migration 007): display only.
  const legacy = await saveFile(mine.eventId, 'legacy-only.jpg');

  // Another album's file, named by a row in this one.
  const foreign = await saveFile(theirs.eventId, 'someone-elses-wedding.jpg');

  // A row whose file is no longer on disk.
  const missing = await saveFile(mine.eventId, 'deleted-from-disk.jpg');
  const missingAbsolute = storageAdapter.getAbsolutePath(missing);
  if (missingAbsolute) fs.rmSync(missingAbsolute, { force: true });

  const insert = (
    storagePath: string,
    originalPath: string | null,
    createdAt: string
  ): Promise<unknown> =>
    pool.query(
      `INSERT INTO photos (event_id, guest_id, storage_path, original_storage_path, full_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [mine.eventId, guest, storagePath, originalPath, storagePath, createdAt]
    );

  await insert(display, original, '2026-01-01T00:00:01Z');
  await insert(legacy, null, '2026-01-01T00:00:02Z');
  await insert(foreign, null, '2026-01-01T00:00:03Z');
  await insert(missing, null, '2026-01-01T00:00:04Z');

  // Local audio is stored as an absolute URL; R2 audio is a CDN URL that
  // carries no /uploads/ segment at all. Both shapes reach the same code.
  const localAudio = await storageAdapter.save(
    Buffer.from('audio-bytes'),
    'guest-message.webm',
    'audio/webm',
    mine.eventId
  );
  await pool.query(
    `INSERT INTO audio_guestbook (event_id, guest_id, audio_url, duration_seconds, created_at)
     VALUES ($1, $6, $2, 5, $3), ($1, $6, $4, 5, $5)`,
    [
      mine.eventId,
      `${CONFIG.PUBLIC_BASE_URL}${localAudio.storagePath}`,
      '2026-01-01T00:00:01Z',
      'https://cdn.example.com/somewhere-else/stray-audio.webm',
      '2026-01-01T00:00:02Z',
      guest,
    ]
  );

  archive = await downloadArchive(mine);
}, 40_000);

afterAll(async () => {
  if (server) server.close();
  await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [
    [mine.eventId, theirs.eventId],
  ]).catch(() => undefined);
});

describe('what the export archive contains', () => {
  it('produces a zip', () => {
    expect(archive.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('leaves out a file belonging to a different album', () => {
    // The finding this guards (SEC-04/SEC-A1). A row in this album naming
    // another album's object must be dropped, and dropped silently enough
    // that the rest of the export still completes.
    expect(archive.toString('latin1')).not.toContain('someone-elses-wedding.jpg');
  });

  it('prefers the untouched original over the display copy', () => {
    // The export is what a host takes to a print shop; handing them the
    // resized web copy is the difference between an album and a screenshot.
    const text = archive.toString('latin1');
    expect(text).toContain('kept-original.jpg');
    expect(text).not.toContain('kept-display.jpg');
  });

  it('falls back to the display copy for a photo that has no original', () => {
    expect(archive.toString('latin1')).toContain('legacy-only.jpg');
  });

  it('skips a row whose file is gone without failing the whole export', () => {
    // One missing file must not cost the host the other three hundred.
    const text = archive.toString('latin1');
    expect(text).not.toContain('deleted-from-disk.jpg');
    expect(text).toContain('legacy-only.jpg');
  });

  it('files photos under a photos/ prefix, numbered', () => {
    expect(archive.toString('latin1')).toMatch(/photos\/photo-\d+-/);
  });

  it('includes an audio message stored as a local absolute URL', () => {
    // The column holds `http://host/uploads/...`; the adapter needs the path.
    const text = archive.toString('latin1');
    expect(text).toContain('audio/audio-');
    expect(text).toContain('guest-message.webm');
  });

  it('leaves out an audio URL that points outside this album', () => {
    expect(archive.toString('latin1')).not.toContain('stray-audio.webm');
  });
});

describe('an album with nothing in it', () => {
  it('still returns a valid empty archive rather than an error', async () => {
    // A host who exports before the wedding should get an empty zip, not a 500.
    const empty = await registerHost();
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
      empty.userId,
    ]);

    const bytes = await downloadArchive(empty);

    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    await query('DELETE FROM events WHERE id = $1', [empty.eventId]).catch(() => undefined);
  }, 20_000);
});

describe('storage usage', () => {
  it('reports the plan position, with the percentage clamped to 100', async () => {
    const res = await fetch(`${BASE_URL}/api/events/${mine.eventId}/usage`, {
      headers: { Authorization: `Bearer ${mine.token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.percentUsed).toBeLessThanOrEqual(100);
    expect(body.percentUsed).toBeGreaterThanOrEqual(0);
    expect(body.usedLabel).toMatch(/B|KB|MB|GB/);
    expect(body.photoCount).toBeGreaterThan(0);
  });

  it('is a 404 for an album that does not exist', async () => {
    const res = await fetch(
      `${BASE_URL}/api/events/00000000-0000-4000-8000-000000000000/usage`,
      { headers: { Authorization: `Bearer ${mine.token}` } }
    );
    expect(res.status).toBe(404);
  });

  it('refuses another host’s album', async () => {
    const res = await fetch(`${BASE_URL}/api/events/${theirs.eventId}/usage`, {
      headers: { Authorization: `Bearer ${mine.token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('minting a ticket', () => {
  it('is a 404 for an album that does not exist', async () => {
    const res = await fetch(
      `${BASE_URL}/api/events/00000000-0000-4000-8000-000000000000/export-token`,
      { method: 'POST', headers: { Authorization: `Bearer ${mine.token}` } }
    );
    expect([403, 404]).toContain(res.status);
  });
});

describe('rows whose stored path never got written', () => {
  it('skips them and still delivers everything else', async () => {
    // `storage_path` and `audio_url` are NOT NULL but not non-empty: a write
    // that failed partway can leave the row with an empty string. The export
    // is the one place a host ever notices, and it must skip the row rather
    // than abort the archive — one broken row cannot cost them the wedding.
    const host = await registerHost();
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
      host.userId,
    ]);
    const guest = await addGuest(host.eventId);
    const good = await saveFile(host.eventId, 'intact.jpg');

    await pool.query(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, created_at)
       VALUES ($1, $2, '', '', '2026-01-01T00:00:01Z'), ($1, $2, $3, $3, '2026-01-01T00:00:02Z')`,
      [host.eventId, guest, good]
    );
    await pool.query(
      `INSERT INTO audio_guestbook (event_id, guest_id, audio_url, duration_seconds)
       VALUES ($1, $2, '', 5)`,
      [host.eventId, guest]
    );

    const bytes = await downloadArchive(host);

    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(bytes.toString('latin1')).toContain('intact.jpg');

    await query('DELETE FROM events WHERE id = $1', [host.eventId]).catch(() => undefined);
  }, 40_000);
});
