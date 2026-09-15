import { PlanTier } from '../types';

export type { PlanTier };

/**
 * Plan copy is stored as i18n keys, not translated text.
 *
 * This module is evaluated once at import, so holding translated strings here
 * would freeze the language at load time and the switcher would do nothing.
 * Components resolve these with `i18n.t(...)` at render.
 * `price` and `storage` stay literal - they are numbers and units.
 */
export interface PlanDetails {
  id: PlanTier;
  name: string;
  badge: string;
  price: string;
  period: string;
  description: string;
  highlighted?: boolean;
  popular?: boolean;
  features: string[];
  maxPhotos: string;
  storage: string;
  activeMonths: string;
}

export const PLANS: Record<PlanTier, PlanDetails> = {
  free: {
    id: 'free',
    name: 'plan.free.name',
    badge: 'plan.free.badge',
    price: '0 €',
    period: 'plan.free.period',
    description: 'plan.free.tagline',
    features: [
      'plan.free.f1',
      'plan.free.f2',
      'plan.free.f3',
      'plan.free.f4',
      'plan.free.f5'
    ],
    maxPhotos: 'plan.free.limit_photos',
    storage: '500 MB',
    activeMonths: 'plan.free.limit_days',
  },
  celebration_pass: {
    id: 'celebration_pass',
    name: 'plan.celebration.name',
    badge: 'plan.celebration.badge',
    price: '49 €',
    period: 'plan.celebration.period',
    description: 'plan.celebration.tagline',
    popular: true,
    highlighted: true,
    features: [
      'plan.celebration.f1',
      'plan.celebration.f2',
      'plan.celebration.f3',
      'plan.celebration.f4',
      'plan.celebration.f5',
      'plan.celebration.f6',
      'plan.celebration.f7'
    ],
    maxPhotos: 'plan.celebration.limit_photos',
    storage: '10 GB',
    activeMonths: 'plan.celebration.limit_days',
  },
  deluxe_keepsake: {
    id: 'deluxe_keepsake',
    name: 'plan.deluxe.name',
    badge: 'plan.deluxe.badge',
    price: '89 €',
    period: 'plan.celebration.period',
    description: 'plan.deluxe.tagline',
    features: [
      'plan.deluxe.f1',
      'plan.deluxe.f2',
      'plan.deluxe.f3',
      'plan.deluxe.f4',
      'plan.deluxe.f5',
      'plan.deluxe.f6',
      'plan.deluxe.f7'
    ],
    maxPhotos: 'plan.celebration.limit_photos',
    storage: '25 GB',
    activeMonths: 'plan.deluxe.limit_days',
  },
  pro_planner: {
    id: 'pro_planner',
    name: 'plan.pro.name',
    badge: 'plan.pro.badge',
    price: '49 €',
    period: 'plan.pro.period',
    description: 'plan.pro.tagline',
    // f2 (white-label), f4 (custom subdomains) and f5 (archive hand-off) were
    // listed here and rendered at the point of sale with no implementation
    // behind any of them. Removed rather than reworded: a plan's feature list
    // is a description of what the money buys, and these are tracked as
    // unbuilt work in MASTER_AUDIT.md §5 until they exist.
    features: [
      'plan.pro.f1',
      'plan.pro.f3',
      'plan.pro.f6'
    ],
    maxPhotos: 'plan.celebration.limit_photos',
    storage: '100 GB',
    activeMonths: 'plan.pro.limit_days',
  }
};
