import { describe, it, expect } from 'vitest';
import { isLiveSubscriptionStatus } from '../../server/lib/stripe';

/**
 * The rule deciding whether a stored Stripe subscription still means "this
 * customer is on the hook".
 *
 * It has two callers that pull in opposite directions, which is why it is
 * worth pinning on its own:
 *
 *   - the checkout route refuses a *second* subscription while one is live,
 *     so treating a live one as dead double-bills the customer;
 *   - the downgrade guard (H7) refuses to drop to free while one is live, so
 *     treating a live one as dead strands them on the free tier with the card
 *     still being charged.
 *
 * This file deliberately does NOT mock `server/lib/stripe` — every other
 * billing spec does, and their test doubles delegate to this same predicate
 * via `vi.importActual` rather than restating the status list. That keeps the
 * doubles from drifting, but it also means this is the only place the list
 * itself is actually asserted.
 */
describe('isLiveSubscriptionStatus', () => {
  it('treats a paying or trialing subscription as live', () => {
    expect(isLiveSubscriptionStatus('active')).toBe(true);
    expect(isLiveSubscriptionStatus('trialing')).toBe(true);
  });

  it('treats a subscription still in dunning as live', () => {
    // Stripe is retrying the card and the subscription has not ended. Dropping
    // the customer to free here would cut off a plan they may still pay for,
    // while the charge keeps being attempted.
    expect(isLiveSubscriptionStatus('past_due')).toBe(true);
    expect(isLiveSubscriptionStatus('unpaid')).toBe(true);
    expect(isLiveSubscriptionStatus('incomplete')).toBe(true);
  });

  it('treats an ended subscription as not live', () => {
    expect(isLiveSubscriptionStatus('canceled')).toBe(false);
    expect(isLiveSubscriptionStatus('incomplete_expired')).toBe(false);
  });

  it('treats anything it does not recognise as not live', () => {
    // A status Stripe adds later, or an empty string from a lookup that failed,
    // must not permanently block a customer from subscribing or downgrading.
    expect(isLiveSubscriptionStatus('')).toBe(false);
    expect(isLiveSubscriptionStatus('some_future_status')).toBe(false);
  });
});
