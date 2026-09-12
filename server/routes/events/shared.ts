/**
 * Schemas, column lists and helpers shared by the event sub-routers.
 *
 * `events.ts` was a single 1073-line router, past the 800-line ceiling in the
 * project's coding standards. It is now a composer over `crud`, `reactions`,
 * `qr` and `export`; everything more than one of them needs lives here.
 */

import { z } from 'zod';
import { BackendPlanTier } from '../../middleware/tierGate';

/**
 * M2 — a slug is not free text. It addresses the event in a URL that QR codes
 * are printed with, and it is interpolated into the export's
 * `Content-Disposition: attachment; filename="<slug>-memories.zip"` header,
 * where a CR/LF makes Node throw ERR_INVALID_CHAR (a 500) and a quote
 * manipulates the filename. Every creation path already ran values through
 * cleanSlug(); the update path accepted anything at all.
 */
export const SlugSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug may contain only lowercase letters, numbers and single hyphens between them.'
  );

export const UpdateEventSchema = z.object({
  slug: SlugSchema.optional(),
  title: z.string().max(200).optional(),
  hostName: z.string().max(100).optional(),
  hostEmail: z.string().email().max(254).optional(),
  eventDate: z.string().optional(),
  venueName: z.string().max(200).optional(),
  coverImageUrl: z.string().url().max(500).optional(),
  themePalette: z.string().max(50).optional(),
  welcomeMessage: z.string().max(1000).optional(),
  isModerationEnabled: z.boolean().optional(),
  isDisposableMode: z.boolean().optional(),
  // H6 — host opt-in to the public showcase. Absent from
  // TIER_GATED_EVENT_FIELDS on purpose: publishing your own album, and
  // withdrawing it again, is a privacy control and never a paid feature.
  isPublic: z.boolean().optional(),
  revealAt: z.string().nullable().optional(),
  maxPhotosPerGuest: z.number().int().positive().max(500).optional(),
});

/**
 * Live reactions are ephemeral: they animate on the projector wall and are gone.
 * Nothing is persisted, so there is no row to moderate or clean up afterwards.
 */
export const REACTION_KINDS = ['heart', 'clap', 'cheers', 'laugh', 'party'] as const;

export const ReactionSchema = z.object({
  reaction: z.enum(REACTION_KINDS),
  guestName: z.string().max(100).optional(),
});

export const QRConfigSchema = z.object({
  canvasSize: z.enum(['A2', 'A3', 'A4', 'TABLE_CARD', 'SQUARE_BANNER']).optional(),
  frameStyle: z.enum(['minimal_gold', 'floral_vintage', 'modern_clean', 'boho_arch', 'double_border', 'art_deco']).optional(),
  headline: z.string().max(100).optional(),
  subtext: z.string().max(300).optional(),
  accentColor: z.string().max(20).optional(),
  // Locally-bundled icon key, not a URL — see migration 013 for why a
  // hotlinked center icon silently vanished from the exported PNG/PDF.
  centerIcon: z.enum(['heart', 'rings', 'camera', 'sparkle', 'none']).optional(),
});

// Safe public columns for the slug/guest endpoint — no host_email, no internal flags
export const PUBLIC_EVENT_COLUMNS = `
  id, title, slug, host_name, event_date, venue_name, welcome_message,
  theme_palette, cover_image_url, created_at
`;

// Full columns for authenticated host access
// `plan_tier` is deliberately absent. The column still exists and is still
// written at creation, but it is a denormalized record, not an entitlement:
// `getEffectiveTierForEvent` derives the live tier from `subscriptions`, and
// every handler below overwrites `planTier` with that. Shipping the column as
// well put a second, staler answer on the wire, which the client accepts as a
// fallback (src/services/eventNormalization.ts) whenever `planTier` is absent.
export const HOST_EVENT_COLUMNS = `
  id, title, slug, host_name, host_email, host_user_id, event_date, venue_name,
  welcome_message, theme_palette, cover_image_url, is_moderation_enabled,
  is_disposable_mode, is_public, max_photos_per_guest, reveal_at, created_at, updated_at
`;

/**
 * Strip host-private fields before an event goes out over the guest WebSocket
 * channel. The host row carries host_email and host_user_id, and every socket in
 * an event room is an unauthenticated guest by default.
 */
export function toPublicEvent(event: Record<string, unknown>) {
  return {
    id: event.id,
    title: event.title,
    slug: event.slug,
    host_name: event.host_name,
    event_date: event.event_date,
    venue_name: event.venue_name,
    welcome_message: event.welcome_message,
    theme_palette: event.theme_palette,
    cover_image_url: event.cover_image_url,
    is_moderation_enabled: event.is_moderation_enabled,
    is_disposable_mode: event.is_disposable_mode,
    is_public: event.is_public,
    max_photos_per_guest: event.max_photos_per_guest,
    reveal_at: event.reveal_at,
    created_at: event.created_at,
    updated_at: event.updated_at,
    planTier: event.planTier,
  };
}

/**
 * Event settings that are sold as paid features. The client hides these behind
 * the same gates (src/config/tierGating.ts), but the client is not an authority —
 * a request that sets one of these must prove the event's tier allows it.
 */
export const TIER_GATED_EVENT_FIELDS: Record<string, BackendPlanTier> = {
  isModerationEnabled: 'celebration_pass',
  isDisposableMode: 'deluxe_keepsake',
  revealAt: 'deluxe_keepsake',
};

export const DEFAULT_THEME = 'champagne_gold';

export const CreateEventSchema = z.object({
  title: z.string().max(200).optional(),
  hostName: z.string().min(2, 'hostName is required').max(100),
  slug: SlugSchema.optional(),
  eventDate: z.string().optional(),
  venueName: z.string().max(200).optional(),
  themePalette: z.string().max(50).optional(),
  welcomeMessage: z.string().max(1000).optional(),
  coverImageUrl: z.string().url().max(500).optional(),
});

export const DeleteEventSchema = z.object({
  /** The event's own slug, typed back by the host. See the route comment. */
  confirmSlug: z.string().min(1, 'confirmSlug is required').max(160),
});
