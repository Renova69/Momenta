import { describe, it, expect, vi } from 'vitest';
import { applyRealtimeMessage } from '../../src/services/realtimeMessages';
import { normalizePartialEvent } from '../../src/services/eventNormalization';
import { ServiceContext } from '../../src/services/storageServiceContext';
import { WeddingEvent } from '../../src/types';

/**
 * M1 — a host's settings change must actually reach the guests watching.
 *
 * The server broadcasts EVENT_UPDATED as `toPublicEvent(...)`, which is raw
 * Postgres column naming (`theme_palette`, `is_moderation_enabled`). The
 * client merged that payload into the stored event verbatim, and
 * `eventService.getEvent()` resolves `parsed.themePalette ?? parsed.theme_palette`
 * — the camelCase key is already populated from the initial load, so the
 * snake_case value it just received never wins. Every live settings broadcast
 * was silently discarded.
 *
 * `toPublicEvent` also deliberately omits host-private columns (host_email,
 * host_user_id), so normalizing has to be *partial*: absent keys are absent,
 * not defaulted, or a host watching their own event would have their email
 * blanked by a broadcast they triggered themselves.
 */

function buildContext(current: Partial<WeddingEvent>) {
  const applied: Partial<WeddingEvent>[] = [];
  const ctx = {
    getEvent: () => current as WeddingEvent,
    getPhotos: () => [],
    getQuests: () => [],
    getAudioEntries: () => [],
    getCurrentGuest: () => null,
    updateEvent: (updates: Partial<WeddingEvent>) => {
      applied.push(updates);
      return { ...current, ...updates } as WeddingEvent;
    },
    notify: vi.fn(),
    notifyError: vi.fn(),
    syncGuestFromServer: vi.fn(),
    completeQuest: vi.fn(),
    joinEventRoom: vi.fn(),
    syncFromBackend: vi.fn().mockResolvedValue(undefined),
    emitReaction: vi.fn(),
  } as unknown as ServiceContext;
  return { ctx, applied };
}

describe('EVENT_UPDATED broadcast normalization (M1)', () => {
  const EVENT_ID = 'e0e0e0e0-1111-4222-8333-444455556666';

  it('converts the broadcast column names into the domain shape', () => {
    const { ctx, applied } = buildContext({
      id: EVENT_ID,
      themePalette: 'champagne_gold',
      isModerationEnabled: false,
    });

    applyRealtimeMessage(ctx, {
      type: 'EVENT_UPDATED',
      eventId: EVENT_ID,
      payload: {
        id: EVENT_ID,
        slug: 'live-update',
        theme_palette: 'rosewood_blush',
        is_moderation_enabled: true,
        welcome_message: 'Welcome, everyone!',
      },
    });

    expect(applied).toHaveLength(1);
    expect(applied[0].themePalette).toBe('rosewood_blush');
    expect(applied[0].isModerationEnabled).toBe(true);
    expect(applied[0].welcomeMessage).toBe('Welcome, everyone!');
  });

  it('does not blank host-private fields the broadcast deliberately omits', () => {
    const { ctx, applied } = buildContext({
      id: EVENT_ID,
      hostEmail: 'host@example.com',
      hostUserId: 'user-1',
    });

    applyRealtimeMessage(ctx, {
      type: 'EVENT_UPDATED',
      eventId: EVENT_ID,
      payload: { id: EVENT_ID, slug: 'live-update', theme_palette: 'rosewood_blush' },
    });

    expect(applied[0]).not.toHaveProperty('hostEmail');
    expect(applied[0]).not.toHaveProperty('hostUserId');
  });

  it('still ignores a broadcast for a different event', () => {
    const { ctx, applied } = buildContext({ id: EVENT_ID });

    applyRealtimeMessage(ctx, {
      type: 'EVENT_UPDATED',
      eventId: 'ffffffff-1111-4222-8333-444455556666',
      payload: { id: 'other', slug: 'other', theme_palette: 'rosewood_blush' },
    });

    expect(applied).toHaveLength(0);
  });
});

describe('normalizePartialEvent', () => {
  it('emits only the keys actually present', () => {
    const result = normalizePartialEvent({ id: 'x', slug: 's', theme_palette: 'noir_emerald' });

    expect(result).toEqual({ id: 'x', slug: 's', themePalette: 'noir_emerald' });
  });

  it('accepts either casing, preferring camelCase', () => {
    const result = normalizePartialEvent({
      venueName: 'Camel Hall',
      venue_name: 'Snake Hall',
      max_photos_per_guest: 25,
    });

    expect(result.venueName).toBe('Camel Hall');
    expect(result.maxPhotosPerGuest).toBe(25);
  });

  it('preserves an explicit null reveal time rather than dropping it', () => {
    // Clearing a disposable reveal is a real edit; `undefined` means "absent".
    expect(normalizePartialEvent({ reveal_at: null }).revealAt).toBeNull();
    expect(normalizePartialEvent({})).toEqual({});
  });
});
