import { CONFIG } from './config';
import { BackendPlanTier } from '../middleware/tierGate';

export type PaidPlanTier = Exclude<BackendPlanTier, 'free'>;

export interface PaidPlanPricing {
  amountCents: number;
  productName: string;
  mode: 'payment' | 'subscription';
}

/**
 * Prices in cents, matching src/config/plans.ts / STORAGE_AND_FINANCIAL_PLAN.md
 * exactly. Defined here rather than pulled from a Stripe Dashboard product —
 * Checkout Sessions can price an ad-hoc line item via `price_data`, so no
 * Stripe product/price needs to exist yet for this to work the moment a real
 * secret key is added. If the price ever needs to change from the Stripe
 * Dashboard side (coupons, localized pricing, etc.) instead, swap these for
 * real `price` IDs read from env vars — the checkout-session route is the
 * only place that would need to change.
 *
 * Lives in its own module because both sides of the payment flow need it:
 * routes/billing.ts prices the Checkout Session, and routes/billingWebhook.ts
 * falls back to these amounts when Stripe's event omits a total.
 */
export const PAID_TIER_PRICING: Record<PaidPlanTier, PaidPlanPricing> = {
  celebration_pass: { amountCents: 4900, productName: 'Celebration Pass', mode: 'payment' },
  deluxe_keepsake: { amountCents: 8900, productName: 'Deluxe Keepsake', mode: 'payment' },
  pro_planner: { amountCents: 4900, productName: 'Pro Planner (monthly)', mode: 'subscription' },
};

/**
 * Narrows a tier string that arrived from outside the process — Stripe event
 * metadata, most importantly — to one this app actually sells. Metadata is
 * free-form on Stripe's side and can be edited from the Dashboard, so it is
 * untrusted input even though we are the ones who originally set it.
 */
export function isPaidTier(tier: string | undefined | null): tier is PaidPlanTier {
  return tier === 'celebration_pass' || tier === 'deluxe_keepsake' || tier === 'pro_planner';
}

/**
 * Stripe Price ID per paid tier, when the operator has created real Products
 * and Prices in the Dashboard. Read through a function rather than captured at
 * module load so tests (and a config reload) see current values.
 */
function priceIdMap(): Record<PaidPlanTier, string> {
  return {
    celebration_pass: CONFIG.STRIPE_PRICE_CELEBRATION_PASS,
    deluxe_keepsake: CONFIG.STRIPE_PRICE_DELUXE_KEEPSAKE,
    pro_planner: CONFIG.STRIPE_PRICE_PRO_PLANNER,
  };
}

/**
 * True only when every paid tier has a Price ID.
 *
 * Deliberately all-or-nothing. A half-configured map would mean the tier is
 * derived from the Price for some purchases and from editable metadata for
 * others — two different trust levels for the same decision, which is exactly
 * the kind of split that hides a bug until it costs money.
 */
export function isPriceMapConfigured(): boolean {
  return Object.values(priceIdMap()).every((id) => id.length > 0);
}

export function priceIdForTier(tier: PaidPlanTier): string {
  return priceIdMap()[tier];
}

/**
 * The tier a Stripe Price actually sells — the authoritative answer to "what
 * did this customer pay for", as opposed to what a session's metadata claims.
 * Returns null for a Price this app does not recognise (created by hand in the
 * Dashboard, or left over from a previous pricing scheme).
 */
export function tierForPriceId(priceId: string | null | undefined): PaidPlanTier | null {
  if (!priceId) return null;
  for (const [tier, id] of Object.entries(priceIdMap())) {
    if (id && id === priceId) return tier as PaidPlanTier;
  }
  return null;
}
