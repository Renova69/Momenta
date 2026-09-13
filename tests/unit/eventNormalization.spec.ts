import { describe, it, expect } from 'vitest';
import {
  normalizeEvent,
  normalizePartialEvent,
  RemoteEventPayload,
} from '../../src/services/eventNormalization';

/**
 * Folding the API's mixed casing into one domain shape.
 *
 * The server returns raw Postgres column names for most fields and camelCase
 * for a few derived ones, so every field here has two or three possible
 * spellings and a precedence order between them. That is a lot of branches for
 * very little code, and getting one backwards is close to invisible: the app
 * keeps working and one setting silently stops updating.
 *
 * `eventBroadcastNormalization.spec.ts` covers the M1 case — that a live
 * EVENT_UPDATED broadcast reaches guests at all. This covers the precedence
 * rules themselves, and the difference between the partial and full
 * normalizers, which is the distinction the whole module exists for.
 */

const minimal: RemoteEventPayload = { id: 'e1', slug: 'ivan-and-maria' };

describe('normalizePartialEvent — emits only what arrived', () => {
  it('returns an empty object for an empty payload', () => {
    expect(normalizePartialEvent({})).toEqual({});
  });

  it('tolerates null and undefined rather than throwing', () => {
    expect(normalizePartialEvent(null as unknown as RemoteEventPayload)).toEqual({});
    expect(normalizePartialEvent(undefined as unknown as RemoteEventPayload)).toEqual({});
  });

  it('omits a field the payload did not carry, instead of defaulting it', () => {
    // This is the whole point (M1). toPublicEvent deliberately omits
    // host_email and host_user_id, so defaulting them would blank a host's own
    // details the moment they changed a setting.
    const result = normalizePartialEvent({ title: 'New Title' });

    expect(result).toEqual({ title: 'New Title' });
    expect('hostEmail' in result).toBe(false);
    expect('hostUserId' in result).toBe(false);
    expect('venueName' in result).toBe(false);
  });

  describe('spelling precedence', () => {
    const cases: [string, Partial<RemoteEventPayload>, Partial<RemoteEventPayload>, unknown][] = [
      ['hostName over couple_names and host_name',
        { hostName: 'camel', couple_names: 'legacy', host_name: 'snake' },
        { couple_names: 'legacy', host_name: 'snake' }, 'camel'],
      ['eventDate over date and event_date',
        { eventDate: 'camel', date: 'legacy', event_date: 'snake' },
        { date: 'legacy', event_date: 'snake' }, 'camel'],
    ];

    it.each(cases)('%s', (_label, allThree, withoutCamel, expected) => {
      const key = Object.keys(allThree)[0] as keyof RemoteEventPayload;
      const out = normalizePartialEvent(allThree) as Record<string, unknown>;
      expect(out[key]).toBe(expected);
      // With the preferred spelling absent, the next in line wins.
      const fallback = normalizePartialEvent(withoutCamel) as Record<string, unknown>;
      expect(fallback[key]).toBe('legacy');
    });

    it('prefers camelCase over snake_case for every paired field', () => {
      const out = normalizePartialEvent({
        hostEmail: 'a@camel', host_email: 'a@snake',
        hostUserId: 'u-camel', host_user_id: 'u-snake',
        venueName: 'v-camel', venue_name: 'v-snake',
        coverImageUrl: 'c-camel', cover_image_url: 'c-snake',
        welcomeMessage: 'w-camel', welcome_message: 'w-snake',
        themePalette: 't-camel', theme_palette: 't-snake',
        planTier: 'p-camel', plan_tier: 'p-snake',
        maxPhotosPerGuest: 11, max_photos_per_guest: 22,
        createdAt: 'cr-camel', created_at: 'cr-snake',
        updatedAt: 'up-camel', updated_at: 'up-snake',
      });

      expect(out).toMatchObject({
        hostEmail: 'a@camel', hostUserId: 'u-camel', venueName: 'v-camel',
        coverImageUrl: 'c-camel', welcomeMessage: 'w-camel',
        themePalette: 't-camel', planTier: 'p-camel',
        maxPhotosPerGuest: 11, createdAt: 'cr-camel', updatedAt: 'up-camel',
      });
    });

    it('falls back to snake_case when the camelCase spelling is absent', () => {
      const out = normalizePartialEvent({
        host_email: 'a@snake', host_user_id: 'u-snake', venue_name: 'v-snake',
        cover_image_url: 'c-snake', welcome_message: 'w-snake',
        theme_palette: 't-snake', plan_tier: 'p-snake',
        max_photos_per_guest: 22, created_at: 'cr-snake', updated_at: 'up-snake',
      });

      expect(out).toMatchObject({
        hostEmail: 'a@snake', hostUserId: 'u-snake', venueName: 'v-snake',
        coverImageUrl: 'c-snake', welcomeMessage: 'w-snake',
        themePalette: 't-snake', planTier: 'p-snake',
        maxPhotosPerGuest: 22, createdAt: 'cr-snake', updatedAt: 'up-snake',
      });
    });
  });

  describe('booleans', () => {
    it('carries false through, rather than treating it as absent', () => {
      // `??` not `||` matters here: a host switching moderation OFF sends
      // false, and `||` would drop the update entirely.
      const out = normalizePartialEvent({
        isModerationEnabled: false,
        isDisposableMode: false,
        isPublic: false,
      });

      expect(out).toEqual({
        isModerationEnabled: false,
        isDisposableMode: false,
        isPublic: false,
      });
    });

    it('accepts the snake_case spelling for each', () => {
      const out = normalizePartialEvent({
        is_moderation_enabled: true,
        is_disposable_mode: true,
        is_public: true,
      });

      expect(out).toEqual({
        isModerationEnabled: true,
        isDisposableMode: true,
        isPublic: true,
      });
    });

    it('prefers camelCase when both spellings disagree', () => {
      const out = normalizePartialEvent({ isPublic: false, is_public: true });
      expect(out.isPublic).toBe(false);
    });
  });

  describe('revealAt — the field where null is a real value', () => {
    it('carries an explicit null through, because that clears a reveal', () => {
      const out = normalizePartialEvent({ revealAt: null });
      expect('revealAt' in out).toBe(true);
      expect(out.revealAt).toBeNull();
    });

    it('carries an explicit snake_case null through', () => {
      const out = normalizePartialEvent({ reveal_at: null });
      expect('revealAt' in out).toBe(true);
      expect(out.revealAt).toBeNull();
    });

    it('omits it entirely when neither spelling is present', () => {
      expect('revealAt' in normalizePartialEvent({ title: 'x' })).toBe(false);
    });

    it('prefers the camelCase value when both are present', () => {
      const out = normalizePartialEvent({ revealAt: '2026-09-20T18:00:00Z', reveal_at: null });
      expect(out.revealAt).toBe('2026-09-20T18:00:00Z');
    });

    it('falls back to snake_case when camelCase is explicitly undefined', () => {
      const out = normalizePartialEvent({ revealAt: undefined, reveal_at: '2026-09-20T18:00:00Z' });
      expect(out.revealAt).toBe('2026-09-20T18:00:00Z');
    });
  });
});

describe('normalizeEvent — fills a default for everything absent', () => {
  it('defaults every optional field from a minimal payload', () => {
    const out = normalizeEvent(minimal);

    expect(out).toMatchObject({
      id: 'e1',
      slug: 'ivan-and-maria',
      title: 'Wedding',
      hostName: '',
      hostEmail: '',
      venueName: 'Venue',
      welcomeMessage: 'Welcome!',
      themePalette: 'champagne_gold',
      planTier: 'free',
      isModerationEnabled: false,
      isDisposableMode: false,
      isPublic: false,
      revealAt: null,
      maxPhotosPerGuest: 50,
    });
    expect(out.coverImageUrl).toContain('unsplash.com');
    expect(out.eventDate).toBeTruthy();
    expect(out.createdAt).toBeTruthy();
    expect(out.updatedAt).toBeTruthy();
  });

  it('never assumes consent from a missing field', () => {
    // isPublic absent means not opted in to the public showcase.
    expect(normalizeEvent(minimal).isPublic).toBe(false);
  });

  it('prefers camelCase across the board', () => {
    const out = normalizeEvent({
      ...minimal,
      hostName: 'camel', couple_names: 'legacy', host_name: 'snake',
      eventDate: '2026-01-01', date: '2025-01-01', event_date: '2024-01-01',
      venueName: 'v-camel', venue_name: 'v-snake',
      themePalette: 'rose_quartz', theme_palette: 'champagne_gold',
      planTier: 'pro_planner', plan_tier: 'free',
    });

    expect(out).toMatchObject({
      hostName: 'camel',
      eventDate: '2026-01-01',
      venueName: 'v-camel',
      themePalette: 'rose_quartz',
      planTier: 'pro_planner',
    });
  });

  it('uses couple_names when hostName is absent, and host_name only after that', () => {
    expect(normalizeEvent({ ...minimal, couple_names: 'legacy', host_name: 'snake' }).hostName)
      .toBe('legacy');
    expect(normalizeEvent({ ...minimal, host_name: 'snake' }).hostName).toBe('snake');
  });

  it('uses date before event_date when eventDate is absent', () => {
    expect(normalizeEvent({ ...minimal, date: '2025-01-01', event_date: '2024-01-01' }).eventDate)
      .toBe('2025-01-01');
    expect(normalizeEvent({ ...minimal, event_date: '2024-01-01' }).eventDate).toBe('2024-01-01');
  });

  it('honours an explicit false for the boolean flags', () => {
    const out = normalizeEvent({
      ...minimal,
      isModerationEnabled: false,
      is_moderation_enabled: true,
      isPublic: false,
      is_public: true,
    });

    expect(out.isModerationEnabled).toBe(false);
    expect(out.isPublic).toBe(false);
  });

  it('takes the snake_case booleans when camelCase is absent', () => {
    const out = normalizeEvent({
      ...minimal,
      is_moderation_enabled: true,
      is_disposable_mode: true,
      is_public: true,
    });

    expect(out).toMatchObject({
      isModerationEnabled: true,
      isDisposableMode: true,
      isPublic: true,
    });
  });

  it('treats a zero per-guest cap as unset, falling back to 50', () => {
    // `||` here, not `??`: the full normalizer is building a usable event, and
    // a cap of zero would accept no photos at all.
    expect(normalizeEvent({ ...minimal, maxPhotosPerGuest: 0 }).maxPhotosPerGuest).toBe(50);
    expect(normalizeEvent({ ...minimal, max_photos_per_guest: 25 }).maxPhotosPerGuest).toBe(25);
  });

  it('resolves revealAt through both spellings, defaulting to null', () => {
    expect(normalizeEvent({ ...minimal, revealAt: '2026-09-20T18:00:00Z' }).revealAt)
      .toBe('2026-09-20T18:00:00Z');
    expect(normalizeEvent({ ...minimal, reveal_at: '2026-09-21T18:00:00Z' }).revealAt)
      .toBe('2026-09-21T18:00:00Z');
    expect(normalizeEvent({ ...minimal, revealAt: null, reveal_at: null }).revealAt).toBeNull();
  });

  it('resolves the timestamps through both spellings', () => {
    const out = normalizeEvent({
      ...minimal,
      createdAt: 'cr-camel', created_at: 'cr-snake',
      updatedAt: 'up-camel', updated_at: 'up-snake',
    });
    expect(out).toMatchObject({ createdAt: 'cr-camel', updatedAt: 'up-camel' });

    const snake = normalizeEvent({ ...minimal, created_at: 'cr-snake', updated_at: 'up-snake' });
    expect(snake).toMatchObject({ createdAt: 'cr-snake', updatedAt: 'up-snake' });
  });

  it('keeps hostUserId undefined rather than inventing one', () => {
    expect(normalizeEvent(minimal).hostUserId).toBeUndefined();
    expect(normalizeEvent({ ...minimal, host_user_id: 'u1' }).hostUserId).toBe('u1');
  });
});
