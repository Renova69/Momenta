import { useEffect, useRef, useState } from 'react';
import { PlanTier } from '../types';
import { TIER_WEIGHTS } from '../../shared/planCaps';

/**
 * What the banner says after Stripe sends the host back.
 *
 * - `confirming` — payment received, plan not granted yet.
 * - `active`     — the album's plan has reached the one bought.
 * - `delayed`    — still not there after a minute; some payment methods
 *                  (SEPA above all) settle days later.
 * - `cancelled`  — checkout abandoned, nothing changed.
 */
export type CheckoutBannerState = 'confirming' | 'active' | 'delayed' | 'cancelled' | null;

/** Where the pricing modal records the tier being bought before redirecting. */
export const CHECKOUT_TIER_KEY = 'wedmoments_checkout_tier';
export const CHECKOUT_POLL_MS = 3000;
export const CHECKOUT_POLL_ATTEMPTS = 20;

function readBoughtTier(): PlanTier | null {
  try {
    const tier = window.sessionStorage.getItem(CHECKOUT_TIER_KEY) as PlanTier | null;
    window.sessionStorage.removeItem(CHECKOUT_TIER_KEY);
    return tier && tier in TIER_WEIGHTS ? tier : null;
  } catch {
    return null;
  }
}

/** Whether `tier` is at least the plan bought; any paid tier when that is unknown. */
function hasArrived(tier: PlanTier | undefined, bought: PlanTier | null): boolean {
  if (!tier) return false;
  if (!bought) return tier !== 'free';
  return (TIER_WEIGHTS[tier] ?? 0) >= (TIER_WEIGHTS[bought] ?? 0);
}

/**
 * N-54 — the plan is granted by Stripe's webhook, not by this redirect. The
 * banner used to announce "your plan is now active" before the webhook had
 * run, and refetched the album once, only if it was already loaded. Now it
 * says what is known, refetches every few seconds until the album's plan
 * reaches the one bought, and says plainly if that takes longer than a minute.
 *
 * Reads and strips `?checkout=` once, so a reload does not show it again.
 */
export function useCheckoutReturn(
  planTier: PlanTier | undefined,
  slug: string | undefined,
  reload: (slug: string) => unknown
): [CheckoutBannerState, () => void] {
  const [state, setState] = useState<CheckoutBannerState>(null);
  const [bought, setBought] = useState<PlanTier | null>(null);
  const [attempts, setAttempts] = useState(0);
  // Held in a ref so a caller passing a new function each render does not
  // keep resetting the poll timer before it can fire.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    if (checkout !== 'success' && checkout !== 'cancelled') return;

    params.delete('checkout');
    const cleanSearch = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (cleanSearch ? `?${cleanSearch}` : ''));

    if (checkout === 'cancelled') {
      setState('cancelled');
      return;
    }
    setBought(readBoughtTier());
    setState('confirming');
  }, []);

  useEffect(() => {
    if (state !== 'confirming') return;
    if (hasArrived(planTier, bought)) {
      setState('active');
      return;
    }
    if (attempts >= CHECKOUT_POLL_ATTEMPTS) {
      setState('delayed');
      return;
    }
    const timer = setTimeout(() => {
      if (slug) reloadRef.current(slug);
      setAttempts((n) => n + 1);
    }, CHECKOUT_POLL_MS);
    return () => clearTimeout(timer);
  }, [state, planTier, bought, attempts, slug]);

  return [state, () => setState(null)];
}
