import { WeddingEvent, ThemePalette, PlanTier } from '../types';

/**
 * An event as it arrives from the API.
 *
 * The server returns raw Postgres column names for most fields and camelCase
 * for a few derived ones (`planTier`), so both spellings are optional here and
 * `normalizeEvent` picks whichever is present.
 */
export interface RemoteEventPayload {
  id: string;
  slug: string;
  title?: string;

  hostName?: string;
  host_name?: string;
  couple_names?: string;
  hostEmail?: string;
  host_email?: string;
  hostUserId?: string;
  host_user_id?: string;

  eventDate?: string;
  event_date?: string;
  date?: string;

  venueName?: string;
  venue_name?: string;
  coverImageUrl?: string;
  cover_image_url?: string;
  welcomeMessage?: string;
  welcome_message?: string;

  themePalette?: string;
  theme_palette?: string;
  planTier?: string;
  plan_tier?: string;

  isModerationEnabled?: boolean;
  is_moderation_enabled?: boolean;
  isDisposableMode?: boolean;
  is_disposable_mode?: boolean;
  isPublic?: boolean;
  is_public?: boolean;

  revealAt?: string | null;
  reveal_at?: string | null;
  maxPhotosPerGuest?: number;
  max_photos_per_guest?: number;

  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
}

/**
 * Fold mixed casing into the domain shape, emitting ONLY the fields the
 * payload actually carried.
 *
 * `normalizeEvent` below fills in a default for everything absent, which is
 * right for a full `GET /api/events/slug/:slug` response and wrong for a
 * partial one. The EVENT_UPDATED WebSocket broadcast is the partial case: it
 * is `toPublicEvent(...)`, which deliberately omits host-private columns
 * (`host_email`, `host_user_id`), so defaulting them would blank a host's own
 * details the moment they changed a setting (M1).
 *
 * `revealAt` is the one field where `null` is a real value — clearing a
 * disposable reveal — so it is distinguished from absent rather than folded
 * away with `??`.
 */
export function normalizePartialEvent(remote: RemoteEventPayload | Partial<RemoteEventPayload>): Partial<WeddingEvent> {
  const source = (remote || {}) as Partial<RemoteEventPayload>;
  const updates: Partial<WeddingEvent> = {};

  const has = (...keys: (keyof RemoteEventPayload)[]): boolean =>
    keys.some((key) => source[key] !== undefined);

  if (has('id')) updates.id = source.id;
  if (has('slug')) updates.slug = source.slug;
  if (has('title')) updates.title = source.title;
  if (has('hostName', 'couple_names', 'host_name')) {
    updates.hostName = source.hostName ?? source.couple_names ?? source.host_name;
  }
  if (has('hostEmail', 'host_email')) updates.hostEmail = source.hostEmail ?? source.host_email;
  if (has('hostUserId', 'host_user_id')) updates.hostUserId = source.hostUserId ?? source.host_user_id;
  if (has('eventDate', 'date', 'event_date')) {
    updates.eventDate = source.eventDate ?? source.date ?? source.event_date;
  }
  if (has('venueName', 'venue_name')) updates.venueName = source.venueName ?? source.venue_name;
  if (has('coverImageUrl', 'cover_image_url')) {
    updates.coverImageUrl = source.coverImageUrl ?? source.cover_image_url;
  }
  if (has('welcomeMessage', 'welcome_message')) {
    updates.welcomeMessage = source.welcomeMessage ?? source.welcome_message;
  }
  if (has('themePalette', 'theme_palette')) {
    updates.themePalette = (source.themePalette ?? source.theme_palette) as WeddingEvent['themePalette'];
  }
  if (has('planTier', 'plan_tier')) {
    updates.planTier = (source.planTier ?? source.plan_tier) as WeddingEvent['planTier'];
  }
  if (has('isModerationEnabled', 'is_moderation_enabled')) {
    updates.isModerationEnabled = source.isModerationEnabled ?? source.is_moderation_enabled;
  }
  if (has('isDisposableMode', 'is_disposable_mode')) {
    updates.isDisposableMode = source.isDisposableMode ?? source.is_disposable_mode;
  }
  if (has('isPublic', 'is_public')) {
    updates.isPublic = source.isPublic ?? source.is_public;
  }
  if ('revealAt' in source || 'reveal_at' in source) {
    updates.revealAt = source.revealAt !== undefined ? source.revealAt : source.reveal_at;
  }
  if (has('maxPhotosPerGuest', 'max_photos_per_guest')) {
    updates.maxPhotosPerGuest = source.maxPhotosPerGuest ?? source.max_photos_per_guest;
  }
  if (has('createdAt', 'created_at')) updates.createdAt = source.createdAt ?? source.created_at;
  if (has('updatedAt', 'updated_at')) updates.updatedAt = source.updatedAt ?? source.updated_at;

  return updates;
}

/** Fold the API's mixed casing into the single domain shape the app uses. */
export function normalizeEvent(remote: RemoteEventPayload): WeddingEvent {
  const now = new Date().toISOString();

  return {
    id: remote.id,
    slug: remote.slug,
    title: remote.title ?? 'Wedding',
    hostName: remote.hostName ?? remote.couple_names ?? remote.host_name ?? '',
    hostEmail: remote.hostEmail ?? remote.host_email ?? '',
    hostUserId: remote.hostUserId ?? remote.host_user_id,
    eventDate: remote.eventDate ?? remote.date ?? remote.event_date ?? now,
    venueName: remote.venueName ?? remote.venue_name ?? 'Venue',
    coverImageUrl:
      remote.coverImageUrl ??
      remote.cover_image_url ??
      'https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80',
    welcomeMessage: remote.welcomeMessage ?? remote.welcome_message ?? 'Welcome!',
    themePalette: (remote.themePalette ?? remote.theme_palette ?? 'champagne_gold') as ThemePalette,
    planTier: (remote.planTier ?? remote.plan_tier ?? 'free') as PlanTier,
    isModerationEnabled: remote.isModerationEnabled ?? remote.is_moderation_enabled ?? false,
    isDisposableMode: remote.isDisposableMode ?? remote.is_disposable_mode ?? false,
    // Absent means not opted in — never assume consent from a missing field.
    isPublic: remote.isPublic ?? remote.is_public ?? false,
    revealAt: remote.revealAt || remote.reveal_at || null,
    maxPhotosPerGuest: remote.maxPhotosPerGuest || remote.max_photos_per_guest || 50,
    createdAt: remote.createdAt || remote.created_at || now,
    updatedAt: remote.updatedAt || remote.updated_at || now,
  };
}
