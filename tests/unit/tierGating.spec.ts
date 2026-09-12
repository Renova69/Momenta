import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isFeatureUnlocked,
  getRequiredTier,
  FREE_TIER_MAX_PHOTOS,
  FEATURE_GATES,
  GatedFeature,
} from '../../src/config/tierGating';
import { requireEventTier, checkPhotoUploadTierLimit } from '../../server/middleware/tierGate';
import { pool } from '../../server/lib/db';
import { TRANSLATIONS } from '../../src/i18n';
import type { Request, Response, NextFunction } from 'express';

describe('Tier Gating Configuration & Helpers', () => {
  it('enforces free tier feature boundaries correctly', () => {
    expect(isFeatureUnlocked('free', 'live_tv')).toBe(false);
    expect(isFeatureUnlocked('free', 'scavenger_quests')).toBe(false);
    expect(isFeatureUnlocked('free', 'audio_guestbook')).toBe(false);
    expect(isFeatureUnlocked('free', 'qr_print_studio')).toBe(false);
    expect(isFeatureUnlocked('free', 'photo_moderation')).toBe(false);
    expect(isFeatureUnlocked('free', 'zip_export')).toBe(false);
    expect(isFeatureUnlocked('free', 'disposable_camera')).toBe(false);
    expect(isFeatureUnlocked('free', 'multi_events')).toBe(false);
  });

  it('enforces celebration_pass tier access correctly', () => {
    // Unlocked on celebration_pass
    expect(isFeatureUnlocked('celebration_pass', 'live_tv')).toBe(true);
    expect(isFeatureUnlocked('celebration_pass', 'scavenger_quests')).toBe(true);
    expect(isFeatureUnlocked('celebration_pass', 'qr_print_studio')).toBe(true);
    expect(isFeatureUnlocked('celebration_pass', 'photo_moderation')).toBe(true);
    expect(isFeatureUnlocked('celebration_pass', 'zip_export')).toBe(true);
    expect(isFeatureUnlocked('celebration_pass', 'custom_themes')).toBe(true);

    // Still locked on celebration_pass
    expect(isFeatureUnlocked('celebration_pass', 'audio_guestbook')).toBe(false);
    expect(isFeatureUnlocked('celebration_pass', 'disposable_camera')).toBe(false);
    expect(isFeatureUnlocked('celebration_pass', 'multi_events')).toBe(false);
  });

  it('enforces deluxe_keepsake tier access correctly', () => {
    // Unlocked on deluxe_keepsake
    expect(isFeatureUnlocked('deluxe_keepsake', 'live_tv')).toBe(true);
    expect(isFeatureUnlocked('deluxe_keepsake', 'scavenger_quests')).toBe(true);
    expect(isFeatureUnlocked('deluxe_keepsake', 'qr_print_studio')).toBe(true);
    expect(isFeatureUnlocked('deluxe_keepsake', 'photo_moderation')).toBe(true);
    expect(isFeatureUnlocked('deluxe_keepsake', 'zip_export')).toBe(true);
    expect(isFeatureUnlocked('deluxe_keepsake', 'audio_guestbook')).toBe(true);
    expect(isFeatureUnlocked('deluxe_keepsake', 'disposable_camera')).toBe(true);

    // Still locked on deluxe_keepsake (agency only)
    expect(isFeatureUnlocked('deluxe_keepsake', 'multi_events')).toBe(false);
  });

  it('enforces pro_planner tier access correctly', () => {
    const allFeatures: GatedFeature[] = [
      'live_tv',
      'scavenger_quests',
      'audio_guestbook',
      'qr_print_studio',
      'photo_moderation',
      'zip_export',
      'disposable_camera',
      'custom_themes',
      'multi_events',
    ];

    allFeatures.forEach((feature) => {
      expect(isFeatureUnlocked('pro_planner', feature)).toBe(true);
    });
  });

  it('correctly reports minimum required tier for each feature', () => {
    expect(getRequiredTier('live_tv')).toBe('celebration_pass');
    expect(getRequiredTier('audio_guestbook')).toBe('deluxe_keepsake');
    expect(getRequiredTier('multi_events')).toBe('pro_planner');
    expect(FREE_TIER_MAX_PHOTOS).toBe(50);
  });

  it('carries a translatable title and description key for every gate', () => {
    Object.values(FEATURE_GATES).forEach((gate) => {
      // The config stores i18n keys, not text: translating at import time would
      // freeze the language when the module first loads.
      expect(gate.titleKey).toMatch(/^gate\.[a-z_]+\.title$/);
      expect(gate.descriptionKey).toMatch(/^gate\.[a-z_]+\.desc$/);

      // Both keys must actually resolve in both dictionaries.
      expect(TRANSLATIONS.bg[gate.titleKey]).toBeTruthy();
      expect(TRANSLATIONS.en[gate.titleKey]).toBeTruthy();
      expect(TRANSLATIONS.bg[gate.descriptionKey]).toBeTruthy();
      expect(TRANSLATIONS.en[gate.descriptionKey]).toBeTruthy();
    });
  });
});

/** A real uuid: requireEventTier validates the shape before it queries. */
const TEST_EVENT_ID = '3f1a9c52-6b7d-4e18-9a24-0c5d8e7b1f30';

describe('Backend Tier Gate Middleware', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects requests missing an eventId parameter', async () => {
    const middleware = requireEventTier('celebration_pass');
    const req = { params: {}, body: {}, query: {} } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an eventId that is not a valid uuid', async () => {
    const queries = vi.spyOn(pool, 'query');
    const middleware = requireEventTier('celebration_pass');
    const req = { params: { id: 'not-a-uuid' } } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    // 400, not the 500 a Postgres 22P02 used to produce, and the database is
    // never reached. POST /api/audio takes its eventId from the request body,
    // where no requireUuidParams runs ahead of this middleware.
    expect(res.status).toHaveBeenCalledWith(400);
    expect(queries).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 if event is not found in database', async () => {
    vi.spyOn(pool, 'query').mockResolvedValueOnce({ rows: [] } as unknown as never);

    const middleware = requireEventTier('celebration_pass');
    const req = { params: { id: TEST_EVENT_ID } } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the host subscription tier is below required tier', async () => {
    vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [{ id: TEST_EVENT_ID }] } as unknown as never)
      .mockResolvedValueOnce({ rows: [{ tier: 'free' }] } as unknown as never);

    const middleware = requireEventTier('deluxe_keepsake');
    const req = { params: { id: TEST_EVENT_ID } } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'TIER_REQUIRED',
        requiredTier: 'deluxe_keepsake',
        currentTier: 'free',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the host subscription tier meets required tier', async () => {
    vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [{ id: TEST_EVENT_ID }] } as unknown as never)
      .mockResolvedValueOnce({ rows: [{ tier: 'deluxe_keepsake' }] } as unknown as never);

    const middleware = requireEventTier('celebration_pass');
    const req = { params: { id: TEST_EVENT_ID } } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('fails closed (blocks upload) when the database errors', async () => {
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db down'));

    const res = await checkPhotoUploadTierLimit(TEST_EVENT_ID);
    expect(res.allowed).toBe(false);
  });

  // The allowance check now gathers the event, tier, usage and counts in a
  // single round trip — splitting them exhausted the connection pool during an
  // upload burst.
  function mockUsageQueries(tier: string, photoCount: number, storageBytes = 0) {
    vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [
        {
          id: TEST_EVENT_ID,
          host_user_id: 'host-1',
          storage_bytes: storageBytes,
          pooled_bytes: storageBytes,
          tier,
          photo_count: photoCount,
          device_photo_count: 0,
          is_moderation_enabled: false,
          is_disposable_mode: false,
          reveal_at: null,
          max_photos_per_guest: 50,
        },
      ],
    } as unknown as never);
  }

  it('enforces the 50 photo limit on the free plan only', async () => {
    mockUsageQueries('free', 10);
    expect((await checkPhotoUploadTierLimit(TEST_EVENT_ID)).allowed).toBe(true);

    mockUsageQueries('free', 50);
    const blocked = await checkPhotoUploadTierLimit(TEST_EVENT_ID);
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('TIER_LIMIT_REACHED');
    expect(blocked.reason).toContain('50');

    // Paid plans have no photo count ceiling.
    mockUsageQueries('celebration_pass', 5000);
    expect((await checkPhotoUploadTierLimit(TEST_EVENT_ID)).allowed).toBe(true);
  });

  it('enforces the storage allowance the plan sells', async () => {
    const halfGb = 512 * 1024 * 1024;

    // Free plan is 512 MB: an upload that fits is allowed.
    mockUsageQueries('free', 1, 1024);
    expect((await checkPhotoUploadTierLimit(TEST_EVENT_ID, 1024)).allowed).toBe(true);

    // The same album cannot take one more byte than the allowance.
    mockUsageQueries('free', 1, halfGb);
    const blocked = await checkPhotoUploadTierLimit(TEST_EVENT_ID, 1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('STORAGE_LIMIT_REACHED');
    expect(blocked.reason).toContain('512 MB');

    // A larger plan accepts what the free plan refused.
    mockUsageQueries('celebration_pass', 1, halfGb);
    expect((await checkPhotoUploadTierLimit(TEST_EVENT_ID, 1)).allowed).toBe(true);
  });
});
