import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import sharp from 'sharp';
import { ingestPhoto, ingestPhotoBuffer } from '../../server/lib/ingestPipeline';
import { pool, query } from '../../server/lib/db';
import { isQuarantined } from '../../server/lib/storage';

/**
 * The photographer ingest pipeline, called directly.
 *
 * `ingestRoutes.spec.ts` covers the HTTP surface in front of this — the ingest
 * key, the batch cap, who may upload. This covers what the pipeline decides
 * once a frame is in its hands, which is where the interesting rules live and
 * where none of them are visible in a 201 response.
 *
 * The stakes are asymmetric. A photographer uploads a wedding in one batch,
 * over FTP, from a laptop in a car park, and nobody looks at the result until
 * the next morning. Every refusal here therefore has to be a refusal rather
 * than an exception: a corrupt frame is a rejected upload and not a 500, and a
 * frame arriving while moderation is on must be written to a quarantined path
 * rather than a publicly-reachable one (MED-03/SEC-M5) — because the whole
 * point of moderation is that nobody sees the photo until the host says so,
 * and "not linked from the feed" is not the same as "not reachable".
 */

/** A real, decodable JPEG — the pipeline resizes it, so a header is not enough. */
let JPEG: Buffer;

/** Passes the magic-byte check but cannot be decoded. */
const CORRUPT_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

const createdEvents: string[] = [];

async function makeEvent(moderation = false): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date, is_moderation_enabled)
     VALUES ($1, 'Ingest Pipeline Spec', 'Spec Host', 'ingest-pipeline@test.local', CURRENT_DATE, $2)
     RETURNING id`,
    [`ingest-pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, moderation]
  );
  createdEvents.push(rows[0].id);
  return rows[0].id;
}

beforeAll(async () => {
  JPEG = await sharp({
    create: { width: 900, height: 600, channels: 3, background: { r: 210, g: 180, b: 120 } },
  })
    .jpeg()
    .toBuffer();
}, 30_000);

afterAll(async () => {
  await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(
    () => undefined
  );
});

describe('what the pipeline refuses', () => {
  it('refuses an empty buffer', async () => {
    const eventId = await makeEvent();
    const outcome = await ingestPhoto(eventId, Buffer.alloc(0), 'x.jpg', 'image/jpeg', {});
    expect(outcome).toEqual({ ok: false, reason: 'not_an_image' });
  });

  it('refuses bytes that are not an image, whatever the client called them', async () => {
    // The declared MIME type comes from the uploader, so it cannot be the
    // thing that decides. A .jpg full of zip bytes is not a photo.
    const eventId = await makeEvent();
    const outcome = await ingestPhoto(
      eventId,
      Buffer.from('PK not a photo at all'),
      'frame.jpg',
      'image/jpeg',
      {}
    );
    expect(outcome).toEqual({ ok: false, reason: 'not_an_image' });
  });

  it('refuses a non-image MIME type even when the bytes look like one', async () => {
    const eventId = await makeEvent();
    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'application/pdf', {});
    expect(outcome).toEqual({ ok: false, reason: 'not_an_image' });
  }, 20_000);

  it('refuses an absent MIME type', async () => {
    const eventId = await makeEvent();
    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', '', {});
    expect(outcome).toEqual({ ok: false, reason: 'not_an_image' });
  }, 20_000);

  it('refuses a frame that cannot be decoded, rather than throwing', async () => {
    // A truncated transfer is the normal failure mode of an FTP upload from a
    // venue. It must cost the photographer one frame, not the batch.
    const eventId = await makeEvent();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const outcome = await ingestPhoto(eventId, CORRUPT_JPEG, 'truncated.jpg', 'image/jpeg', {});

    expect(outcome).toEqual({ ok: false, reason: 'not_an_image' });
    vi.restoreAllMocks();
  }, 20_000);

  it('reports a plan limit as a refusal with the reason attached', async () => {
    const eventId = await makeEvent();
    const tierGate = await import('../../server/middleware/tierGate');
    vi.spyOn(tierGate, 'checkPhotoUploadTierLimit').mockResolvedValue({
      allowed: false,
      reason: 'Storage limit reached for this plan',
    } as Awaited<ReturnType<typeof tierGate.checkPhotoUploadTierLimit>>);

    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'image/jpeg', {});

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'tier_limit',
      message: 'Storage limit reached for this plan',
    });
    vi.restoreAllMocks();
  }, 20_000);

  it('still explains itself when the gate gives no reason', async () => {
    const eventId = await makeEvent();
    const tierGate = await import('../../server/middleware/tierGate');
    vi.spyOn(tierGate, 'checkPhotoUploadTierLimit').mockResolvedValue({
      allowed: false,
    } as Awaited<ReturnType<typeof tierGate.checkPhotoUploadTierLimit>>);

    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'image/jpeg', {});

    expect(outcome).toMatchObject({ ok: false, reason: 'tier_limit' });
    expect((outcome as { message: string }).message).toBeTruthy();
    vi.restoreAllMocks();
  }, 20_000);
});

describe('a frame that is accepted', () => {
  it('is marked as a photographer frame, ahead of the guest photos', async () => {
    // priority 10 is what puts the professional frames at the front of the
    // projector rotation rather than interleaved with phone snaps.
    const eventId = await makeEvent();

    const outcome = await ingestPhoto(eventId, JPEG, 'DSC_0001.JPG', 'image/jpeg', {});

    expect(outcome.ok).toBe(true);
    const photo = (outcome as { photo: Record<string, unknown> }).photo;
    expect(photo.source).toBe('photographer');
    expect(photo.priority).toBe(10);
    expect(photo.status).toBe('approved');
  }, 30_000);

  it('keeps the original alongside the display and thumbnail copies', async () => {
    const eventId = await makeEvent();

    const outcome = await ingestPhoto(eventId, JPEG, 'DSC_0002.JPG', 'image/jpeg', {});

    const photo = (outcome as { photo: Record<string, unknown> }).photo;
    expect(photo.originalUrl).toBeTruthy();
    expect(photo.fullUrl).toBeTruthy();
    expect(photo.thumbnailUrl).toBeTruthy();
    expect(photo.thumbnailUrl).not.toBe(photo.fullUrl);
  }, 30_000);

  it('names the photographer, defaulting when none was given', async () => {
    const eventId = await makeEvent();

    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'image/jpeg', {});

    expect((outcome as { photo: { photographerName: string } }).photo.photographerName).toBe(
      'Official Photographer'
    );
  }, 30_000);

  it('uses the name it was given, trimmed', async () => {
    const eventId = await makeEvent();

    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'image/jpeg', {
      photographerName: '  Ivan Petrov  ',
    });

    expect((outcome as { photo: { photographerName: string } }).photo.photographerName).toBe(
      'Ivan Petrov'
    );
  }, 30_000);

  it('treats a whitespace-only name as no name at all', async () => {
    const eventId = await makeEvent();

    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'image/jpeg', {
      photographerName: '   ',
    });

    expect((outcome as { photo: { photographerName: string } }).photo.photographerName).toBe(
      'Official Photographer'
    );
  }, 30_000);

  it('stores a caption, and stores null rather than an empty string', async () => {
    const eventId = await makeEvent();

    const withCaption = await ingestPhoto(eventId, JPEG, 'a.jpg', 'image/jpeg', {
      caption: '  First dance  ',
    });
    const withoutCaption = await ingestPhoto(eventId, JPEG, 'b.jpg', 'image/jpeg', {
      caption: '   ',
    });

    expect((withCaption as { photo: { caption: string } }).photo.caption).toBe('First dance');
    expect((withoutCaption as { photo: { caption: string | null } }).photo.caption).toBeNull();
  }, 40_000);

  it('files every frame under one photographer guest, not one per upload', async () => {
    // Otherwise a 400-frame wedding creates 400 guests, and the guest list the
    // host actually looks at becomes unusable.
    const eventId = await makeEvent();

    const first = await ingestPhoto(eventId, JPEG, 'a.jpg', 'image/jpeg', {});
    const second = await ingestPhoto(eventId, JPEG, 'b.jpg', 'image/jpeg', {});

    const firstGuest = (first as { photo: { guestId: string } }).photo.guestId;
    const secondGuest = (second as { photo: { guestId: string } }).photo.guestId;
    expect(secondGuest).toBe(firstGuest);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM guests WHERE event_id = $1', [
      eventId,
    ]);
    expect(rows[0].c).toBe(1);
  }, 40_000);
});

describe('when the host has moderation switched on', () => {
  it('holds the frame as pending', async () => {
    const eventId = await makeEvent(true);

    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'image/jpeg', {});

    expect((outcome as { photo: { status: string } }).photo.status).toBe('pending');
  }, 30_000);

  it('writes it to a quarantined path, not a publicly-reachable one', async () => {
    // MED-03/SEC-M5. A pending photo that merely isn't linked from the feed is
    // still one guessable URL away from being public, and the FTP path must
    // not be the way around a host's own moderation setting.
    const eventId = await makeEvent(true);

    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'image/jpeg', {});

    const photo = (outcome as { photo: { storagePath: string } }).photo;
    expect(isQuarantined(photo.storagePath)).toBe(true);
  }, 30_000);

  it('leaves an unmoderated album’s frames on the ordinary path', async () => {
    const eventId = await makeEvent(false);

    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'image/jpeg', {});

    const photo = (outcome as { photo: { storagePath: string } }).photo;
    expect(isQuarantined(photo.storagePath)).toBe(false);
  }, 30_000);
});

describe('ingestPhotoBuffer', () => {
  it('returns the photo on success', async () => {
    const eventId = await makeEvent();

    const photo = await ingestPhotoBuffer(eventId, JPEG, 'frame.jpg', 'image/jpeg', {});

    expect(photo).not.toBeNull();
    expect(photo!.source).toBe('photographer');
  }, 30_000);

  it('returns null rather than the reason, which is why it is not the one to call', async () => {
    const eventId = await makeEvent();

    const photo = await ingestPhotoBuffer(eventId, Buffer.alloc(0), 'frame.jpg', 'image/jpeg', {});

    expect(photo).toBeNull();
  });
});
