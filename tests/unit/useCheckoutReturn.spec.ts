import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCheckoutReturn, CHECKOUT_POLL_MS, CHECKOUT_POLL_ATTEMPTS } from '../../src/hooks/useCheckoutReturn';
import { PlanTier } from '../../src/types';

/**
 * N-54 — after Stripe's checkout the host came back to "Payment successful!
 * Your plan is now active." That was written before the webhook had granted
 * anything, and for a delayed payment method (SEPA) the grant comes days
 * later. The banner now says what is known — payment received, plan pending —
 * and keeps checking until the plan actually arrives.
 *
 * The plan being bought travels in the return URL itself (`?tier=`), so
 * nothing depends on browser storage that can be blocked or left stale.
 */

function arriveFromCheckout(result: 'success' | 'cancelled', boughtTier?: PlanTier) {
  const tier = boughtTier ? `&tier=${boughtTier}` : '';
  window.history.replaceState({}, '', `/host?event=our-wedding&checkout=${result}${tier}`);
}

/** One poll per step: each check is scheduled after the previous render. */
async function poll(times: number) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      vi.advanceTimersByTime(CHECKOUT_POLL_MS);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState({}, '', '/');
});

describe('coming back from checkout (N-54)', () => {
  it('says the payment is being confirmed, and strips only its own parameters', () => {
    arriveFromCheckout('success', 'celebration_pass');

    const { result } = renderHook(() => useCheckoutReturn('free', vi.fn()));

    expect(result.current[0]).toBe('confirming');
    expect(window.location.search).toBe('?event=our-wedding');
  });

  it('refreshes quietly until the plan arrives, then says it is active', async () => {
    arriveFromCheckout('success', 'celebration_pass');
    const refresh = vi.fn();
    let tier: PlanTier = 'free';
    const { result, rerender } = renderHook(() => useCheckoutReturn(tier, refresh));

    await poll(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result.current[0]).toBe('confirming');

    tier = 'celebration_pass';
    rerender();

    expect(result.current[0]).toBe('active');
  });

  it('does not call a plan active that the album already had before paying', async () => {
    // Upgrading Celebration Pass to Deluxe: the album is paid already, so
    // "any paid plan" is not evidence that this purchase arrived.
    arriveFromCheckout('success', 'deluxe_keepsake');
    let tier: PlanTier = 'celebration_pass';
    const { result, rerender } = renderHook(() => useCheckoutReturn(tier, vi.fn()));

    expect(result.current[0]).toBe('confirming');

    tier = 'deluxe_keepsake';
    rerender();
    expect(result.current[0]).toBe('active');
  });

  it('without a plan in the URL, waits for the plan to rise above the one it first saw', async () => {
    arriveFromCheckout('success');
    let tier: PlanTier = 'celebration_pass';
    const { result, rerender } = renderHook(() => useCheckoutReturn(tier, vi.fn()));

    expect(result.current[0]).toBe('confirming');

    tier = 'deluxe_keepsake';
    rerender();
    expect(result.current[0]).toBe('active');
  });

  it('ignores a tier parameter that is not a plan', () => {
    arriveFromCheckout('success');
    window.history.replaceState({}, '', '/host?checkout=success&tier=platinum');

    const { result } = renderHook(() => useCheckoutReturn('free', vi.fn()));

    expect(result.current[0]).toBe('confirming');
  });

  it('says so plainly when the plan has not arrived after a minute', async () => {
    arriveFromCheckout('success', 'deluxe_keepsake');
    const { result } = renderHook(() => useCheckoutReturn('free', vi.fn()));

    await poll(CHECKOUT_POLL_ATTEMPTS + 1);

    expect(result.current[0]).toBe('delayed');
  });

  it('stops checking once the plan has arrived', async () => {
    arriveFromCheckout('success', 'celebration_pass');
    const refresh = vi.fn();
    const { result } = renderHook(() => useCheckoutReturn('celebration_pass', refresh));
    expect(result.current[0]).toBe('active');

    await poll(5);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports a cancelled checkout as before', () => {
    arriveFromCheckout('cancelled');

    const { result } = renderHook(() => useCheckoutReturn('free', vi.fn()));

    expect(result.current[0]).toBe('cancelled');
  });

  it('shows nothing on an ordinary visit', () => {
    const { result } = renderHook(() => useCheckoutReturn('free', vi.fn()));

    expect(result.current[0]).toBeNull();
  });
});
