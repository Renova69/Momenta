import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * Bytes that are not an image must never reach the image decoder.
 *
 * `ingestPhoto` refuses them twice over: a magic-byte check before anything
 * else, and `buildDerivatives` failing to decode them further down. Both return
 * the same `not_an_image`, which is why mutation testing found the first check
 * removable with nothing noticing — the outcome is identical either way.
 *
 * The outcome is not the point of the first check. `buildDerivatives` is sharp,
 * and handing sharp arbitrary attacker-supplied bytes is what SEC-M2 is about:
 * the pixel-bomb cap exists there precisely because decoding untrusted input is
 * where the cost lands. The magic-byte gate is what stops a crafted payload
 * from being decoded at all, and the only way to assert it is to watch whether
 * the decoder was invoked.
 *
 * Hence the mock: it is not stubbing an awkward dependency, it is the
 * measurement.
 */

const decode = vi.hoisted(() => vi.fn());

vi.mock('../../server/lib/images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/images')>();
  return {
    ...actual,
    buildDerivatives: (...args: Parameters<typeof actual.buildDerivatives>) => {
      decode(...args);
      return actual.buildDerivatives(...args);
    },
  };
});

const createdEvents: string[] = [];
let JPEG: Buffer;

async function makeEvent(): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO events (slug, title, host_name, host_email, event_date)
     VALUES ($1, 'Decoder Guard Spec', 'Decoder Host', 'decoder-spec@test.local', CURRENT_DATE)
     RETURNING id`,
    [`decoder-guard-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`]
  );
  createdEvents.push(rows[0].id);
  return rows[0].id;
}

beforeAll(async () => {
  JPEG = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 180, b: 160 } },
  })
    .jpeg()
    .toBuffer();
}, 30_000);

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
});

describe('the magic-byte gate on photographer ingest', () => {
  it('refuses non-image bytes without ever calling the decoder', async () => {
    const { ingestPhoto } = await import('../../server/lib/ingestPipeline');
    decode.mockClear();
    const eventId = await makeEvent();

    // Declared as a JPEG, because the declared type is the uploader's word.
    const outcome = await ingestPhoto(
      eventId,
      Buffer.from('PK\x03\x04 this is a zip wearing a .jpg'),
      'frame.jpg',
      'image/jpeg',
      {}
    );

    expect(outcome).toEqual({ ok: false, reason: 'not_an_image' });
    // The whole assertion. Without the gate the refusal still happens, one
    // sharp decode later.
    expect(decode).not.toHaveBeenCalled();
  }, 30_000);

  it('still decodes bytes that really are an image', async () => {
    // Otherwise the assertion above is satisfied by a gate that refuses
    // everything.
    const { ingestPhoto } = await import('../../server/lib/ingestPipeline');
    decode.mockClear();
    const eventId = await makeEvent();

    const outcome = await ingestPhoto(eventId, JPEG, 'frame.jpg', 'image/jpeg', {});

    expect(outcome.ok).toBe(true);
    expect(decode).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('refuses an empty buffer without calling the decoder either', async () => {
    const { ingestPhoto } = await import('../../server/lib/ingestPipeline');
    decode.mockClear();
    const eventId = await makeEvent();

    const outcome = await ingestPhoto(eventId, Buffer.alloc(0), 'frame.jpg', 'image/jpeg', {});

    expect(outcome).toEqual({ ok: false, reason: 'not_an_image' });
    expect(decode).not.toHaveBeenCalled();
  }, 30_000);
});
