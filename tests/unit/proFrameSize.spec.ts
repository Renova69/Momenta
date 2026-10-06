import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import sharp from 'sharp';
import { buildDerivatives, isPixelLimitError, PRO_MAX_INPUT_PIXELS } from '../../server/lib/images';
import { ingestPhoto } from '../../server/lib/ingestPipeline';
import { pool } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

const createdEvents: string[] = [];

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
});

/**
 * N-65 — the 40-megapixel decode cap (SEC-M2) was written for guest phones,
 * but the photographer path used it too. A 45 MP Canon R5 or 61 MP Sony frame
 * was refused as "not an image" — and over FTP, deleted after the camera had
 * been told it arrived. Photographer ingest is key-authenticated, so it gets a
 * cap sized for professional bodies; the guest path keeps 40 MP; and a frame
 * over a cap is reported as too large, not as something that is not a photo.
 */

// 8000 x 5125 = 41,000,000 pixels: just over the guest cap.
let frame41mp: Buffer;

beforeAll(async () => {
  frame41mp = await sharp({
    create: { width: 8000, height: 5125, channels: 3, background: { r: 150, g: 120, b: 90 } },
  })
    .jpeg({ quality: 60 })
    .toBuffer();
}, 60_000);

describe('the size of frame a professional camera produces (N-65)', () => {
  it('is accepted on the photographer path', async () => {
    const derivatives = await buildDerivatives(frame41mp, { maxInputPixels: PRO_MAX_INPUT_PIXELS });

    expect(derivatives.width).toBe(8000);
    expect(derivatives.height).toBe(5125);
  }, 60_000);

  it('is ingested when a photographer uploads it', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO events (slug, title, host_name, host_email, event_date)
       VALUES ($1, 'Pro Frame Spec', 'Spec Host', 'pro-frame@test.local', CURRENT_DATE) RETURNING id`,
      [`pro-frame-${Date.now()}`]
    );
    createdEvents.push(rows[0].id);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const outcome = await ingestPhoto(rows[0].id, frame41mp, 'R5_0001.jpg', 'image/jpeg', {});

    expect(outcome.ok).toBe(true);
  }, 60_000);

  it('still exceeds what a guest upload may decode', async () => {
    await expect(buildDerivatives(frame41mp)).rejects.toSatisfy(isPixelLimitError);
  }, 60_000);

  it('allows the largest bodies sold today, medium format included', () => {
    // Fujifilm GFX100: 11648 x 8736.
    expect(PRO_MAX_INPUT_PIXELS).toBeGreaterThanOrEqual(11648 * 8736);
  });

  it('tells a pixel-limit refusal apart from a broken file', async () => {
    const broken = await buildDerivatives(Buffer.from('not an image at all')).catch((err: unknown) => err);

    expect(isPixelLimitError(broken)).toBe(false);
  });
});
