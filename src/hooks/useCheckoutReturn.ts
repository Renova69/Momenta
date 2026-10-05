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

export const CHECKOUT_POLL_MS = 3000;
export const CHECKOUT_POLL_ATTEMPTS = 20;

const rank = (tier: PlanTier): number => TIER_WEIGHTS[tier] ?? 0;

/** The plan named in the return URL, if it is one. */
function parseTier(value: string | null): PlanTier | null {
  return value && value in TIER_WEIGHTS ? (value as PlanTier) : null;
}

/**
 * N-54 — the plan is granted by Stripe's webhook, not by this redirect. The
 * banner used to announce "your plan is now active" before the webhook had
 * run. Now it says what is known, quietly refreshes the album every few
 * seconds until its plan reaches the one bought, and says plainly if that
 * takes longer than a minute.
 *
 * The plan bought arrives as `?tier=` on the return URL (PricingPlansModal
 * puts it there), so nothing depends on browser storage. Without it, the plan
 * must rise above the first tier seen here: an album that was already paid is
 * not evidence that this purchase arrived.
 *
 * `refresh` must be quiet — no loading screen, no navigation — because it
 * runs every few seconds while the host is looking at the page.
 */
export function useCheckoutReturn(
  planTier: PlanTier | undefined,
  refresh: () => unknown
): [CheckoutBannerState, () => void] {
  const [state, setState] = useState<CheckoutBannerState>(null);
  const [bought, setBought] = useState<PlanTier | null>(null);
  const [baseline, setBaseline] = useState<PlanTier | null>(null);
  const [attempts, setAttempts] = useState(0);
  // Held in a ref so a caller passing a new function each render does not
  // keep resetting the poll timer before it can fire.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    if (checkout !== 'success' && checkout !== 'cancelled') return;

    const tier = parseTier(params.get('tier'));
    params.delete('checkout');
    params.delete('tier');
    const cleanSearch = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (cleanSearch ? `?${cleanSearch}` : ''));

    if (checkout === 'cancelled') {
      setState('cancelled');
      return;
    }
    setBought(tier);
    setState('confirming');
  }, []);

  // The first tier seen while confirming, for when the URL named none.
  useEffect(() => {
    if (state === 'confirming' && !bought && !baseline && planTier) setBaseline(planTier);
  }, [state, bought, baseline, planTier]);

  useEffect(() => {
    if (state !== 'confirming') return;
    const arrived = bought
      ? !!planTier && rank(planTier) >= rank(bought)
      : !!planTier && !!baseline && rank(planTier) > rank(baseline);
    if (arrived) {
      setState('active');
      return;
    }
    if (attempts >= CHECKOUT_POLL_ATTEMPTS) {
      setState('delayed');
      return;
    }
    const timer = setTimeout(() => {
      refreshRef.current();
      setAttempts((n) => n + 1);
    }, CHECKOUT_POLL_MS);
    return () => clearTimeout(timer);
  }, [state, planTier, bought, baseline, attempts]);

  return [state, () => setState(null)];
}
