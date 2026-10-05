import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCheckoutReturn, CHECKOUT_TIER_KEY, CHECKOUT_POLL_MS, CHECKOUT_POLL_ATTEMPTS } from '../../src/hooks/useCheckoutReturn';
import { PlanTier } from '../../src/types';

/**
 * N-54 — after Stripe's checkout the host came back to "Payment successful!
 * Your plan is now active." That was written before the webhook had granted
 * anything, and for a delayed payment method (SEPA) the grant comes days
 * later. The page refetched the album once, and only if it was already
 * loaded on the first render, so the plan badge and locked features stayed
 * wrong until a manual reload. The banner now says what is known — payment
 * received, plan pending — and keeps checking until the plan actually
 * arrives, or says plainly that it is still being confirmed.
 */

function arriveFromCheckout(result: 'success' | 'cancelled', boughtTier?: PlanTier) {
  window.history.replaceState({}, '', `/host?checkout=${result}`);
  if (boughtTier) window.sessionStorage.setItem(CHECKOUT_TIER_KEY, boughtTier);
}

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState({}, '', '/');
});

describe('coming back from checkout (N-54)', () => {
  it('says the payment is being confirmed, not that the plan is active', () => {
    arriveFromCheckout('success', 'celebration_pass');

    const { result } = renderHook(() => useCheckoutReturn('free', 'our-wedding', vi.fn()));

    expect(result.current[0]).toBe('confirming');
    expect(window.location.search).toBe('');
  });

  it('keeps checking until the plan arrives, then says it is active', async () => {
    arriveFromCheckout('success', 'celebration_pass');
    const reload = vi.fn();
    let tier: PlanTier = 'free';
    const { result, rerender } = renderHook(() => useCheckoutReturn(tier, 'our-wedding', reload));

    await act(async () => {
      vi.advanceTimersByTime(CHECKOUT_POLL_MS * 2);
    });
    expect(reload).toHaveBeenCalledWith('our-wedding');
    expect(result.current[0]).toBe('confirming');

    tier = 'celebration_pass';
    rerender();

    expect(result.current[0]).toBe('active');
  });

  it('says so plainly when the plan has not arrived after a minute', async () => {
    arriveFromCheckout('success', 'deluxe_keepsake');
    const { result } = renderHook(() => useCheckoutReturn('free', 'our-wedding', vi.fn()));

    // One poll per step: each check is scheduled after the previous render.
    for (let i = 0; i <= CHECKOUT_POLL_ATTEMPTS; i++) {
      await act(async () => {
        vi.advanceTimersByTime(CHECKOUT_POLL_MS);
      });
    }

    expect(result.current[0]).toBe('delayed');
  });

  it('stops checking once the plan has arrived', async () => {
    arriveFromCheckout('success', 'celebration_pass');
    const reload = vi.fn();
    const { result } = renderHook(() => useCheckoutReturn('celebration_pass', 'our-wedding', reload));
    expect(result.current[0]).toBe('active');

    await act(async () => {
      vi.advanceTimersByTime(CHECKOUT_POLL_MS * 5);
    });

    expect(reload).not.toHaveBeenCalled();
  });

  it('reports a cancelled checkout as before', () => {
    arriveFromCheckout('cancelled');

    const { result } = renderHook(() => useCheckoutReturn('free', 'our-wedding', vi.fn()));

    expect(result.current[0]).toBe('cancelled');
  });

  it('shows nothing on an ordinary visit', () => {
    const { result } = renderHook(() => useCheckoutReturn('free', 'our-wedding', vi.fn()));

    expect(result.current[0]).toBeNull();
  });
});
