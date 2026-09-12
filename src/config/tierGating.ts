import { PlanTier } from '../types';

export type GatedFeature =
  | 'live_tv'
  | 'scavenger_quests'
  | 'audio_guestbook'
  | 'qr_print_studio'
  | 'photo_moderation'
  | 'zip_export'
  | 'disposable_camera'
  | 'custom_themes'
  | 'multi_events';

/** `titleKey` and `descriptionKey` are i18n keys resolved at render. */
export interface FeatureGateDefinition {
  feature: GatedFeature;
  minimumTier: PlanTier;
  titleKey: string;
  descriptionKey: string;
}

export const TIER_WEIGHTS: Record<PlanTier, number> = {
  free: 0,
  celebration_pass: 1,
  deluxe_keepsake: 2,
  pro_planner: 3,
};

export const FEATURE_GATES: Record<GatedFeature, FeatureGateDefinition> = {
  live_tv: {
    feature: 'live_tv',
    minimumTier: 'celebration_pass',
    titleKey: 'gate.live_tv.title',
    descriptionKey: 'gate.live_tv.desc',
  },
  scavenger_quests: {
    feature: 'scavenger_quests',
    minimumTier: 'celebration_pass',
    titleKey: 'gate.scavenger_quests.title',
    descriptionKey: 'gate.scavenger_quests.desc',
  },
  audio_guestbook: {
    feature: 'audio_guestbook',
    minimumTier: 'deluxe_keepsake',
    titleKey: 'gate.audio_guestbook.title',
    descriptionKey: 'gate.audio_guestbook.desc',
  },
  qr_print_studio: {
    feature: 'qr_print_studio',
    minimumTier: 'celebration_pass',
    titleKey: 'gate.qr_print_studio.title',
    descriptionKey: 'gate.qr_print_studio.desc',
  },
  photo_moderation: {
    feature: 'photo_moderation',
    minimumTier: 'celebration_pass',
    titleKey: 'gate.photo_moderation.title',
    descriptionKey: 'gate.photo_moderation.desc',
  },
  zip_export: {
    feature: 'zip_export',
    minimumTier: 'celebration_pass',
    titleKey: 'gate.zip_export.title',
    descriptionKey: 'gate.zip_export.desc',
  },
  disposable_camera: {
    feature: 'disposable_camera',
    minimumTier: 'deluxe_keepsake',
    titleKey: 'gate.disposable_camera.title',
    descriptionKey: 'gate.disposable_camera.desc',
  },
  custom_themes: {
    feature: 'custom_themes',
    minimumTier: 'celebration_pass',
    titleKey: 'gate.custom_themes.title',
    descriptionKey: 'gate.custom_themes.desc',
  },
  multi_events: {
    feature: 'multi_events',
    minimumTier: 'pro_planner',
    titleKey: 'gate.multi_events.title',
    descriptionKey: 'gate.multi_events.desc',
  },
};

/**
 * Checks if a given feature is accessible by the specified plan tier.
 */
export function isFeatureUnlocked(tier: PlanTier = 'free', feature: GatedFeature): boolean {
  const currentWeight = TIER_WEIGHTS[tier] ?? 0;
  const requiredTier = FEATURE_GATES[feature]?.minimumTier || 'free';
  const requiredWeight = TIER_WEIGHTS[requiredTier] ?? 0;

  return currentWeight >= requiredWeight;
}

/**
 * Returns the minimum required tier for a given feature.
 */
export function getRequiredTier(feature: GatedFeature): PlanTier {
  return FEATURE_GATES[feature]?.minimumTier || 'free';
}

/**
 * Maximum allowed photos for the free tier.
 *
 * Re-exported from `shared/planCaps.ts`, which the server's PLAN_LIMITS reads
 * too, so the warning this drives cannot disagree with what uploads enforce.
 */
export { FREE_TIER_MAX_PHOTOS } from '../../shared/planCaps';
