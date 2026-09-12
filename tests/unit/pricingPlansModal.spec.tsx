import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';

import { PricingPlansModal } from '../../src/components/host/PricingPlansModal';
import { PLANS } from '../../src/config/plans';
import { PlanTier } from '../../src/types';
import { i18n } from '../../src/i18n';
import confetti from 'canvas-confetti';

// G1 (OPEN_ITEMS.md) — billing-critical: this is the only place a host
// actually triggers a plan change. A paid tier now tries a real Stripe
// Checkout Session first (server/routes/billing.ts) and only falls back to
// the direct self-serve write (onUpgradePlan) on a 503 STRIPE_NOT_CONFIGURED
// — which is genuinely the current state of this dev environment, since no
// real Stripe keys are set yet. `global.fetch` is mocked here rather than
// left real: jsdom has no browser origin to resolve a relative /api/...
// URL against, so an unmocked call fails at the fetch layer itself before
// it can ever reach the component logic under test.

function mockFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      mockFetchResponse(503, { error: 'Payments are not configured yet.', code: 'STRIPE_NOT_CONFIGURED' })
    )
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function choosePlanButton(tier: PlanTier): HTMLElement {
  const planName = i18n.t(PLANS[tier].name);
  const heading = screen.getByText(planName);
  const card = heading.closest('div.rounded-2xl') as HTMLElement;
  return card.querySelector('button')!;
}

describe('PricingPlansModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <PricingPlansModal isOpen={false} onClose={vi.fn()} currentPlanTier="free" onUpgradePlan={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders every plan tier with its price, and marks the current plan as current', () => {
    render(
      <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="celebration_pass" onUpgradePlan={vi.fn()} />
    );

    for (const tier of Object.keys(PLANS) as PlanTier[]) {
      const heading = screen.getByText(i18n.t(PLANS[tier].name));
      const card = heading.closest('div.rounded-2xl') as HTMLElement;
      expect(card).toHaveTextContent(PLANS[tier].price);
    }

    const currentButton = choosePlanButton('celebration_pass');
    expect(currentButton).toBeDisabled();
    expect(currentButton).toHaveTextContent(i18n.t('pricing.current_plan'));
  });

  it('upgrades on success: calls onUpgradePlan, fires confetti, then closes after the celebration beat', async () => {
    vi.useFakeTimers();
    const onUpgradePlan = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <PricingPlansModal isOpen onClose={onClose} currentPlanTier="free" onUpgradePlan={onUpgradePlan} />
    );

    await act(async () => {
      fireEvent.click(choosePlanButton('celebration_pass'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onUpgradePlan).toHaveBeenCalledWith('celebration_pass');
    expect(confetti).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables every non-current plan button while an upgrade is in flight', async () => {
    let resolveUpgrade: () => void = () => {};
    const onUpgradePlan = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpgrade = resolve;
        })
    );
    render(
      <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="free" onUpgradePlan={onUpgradePlan} />
    );

    fireEvent.click(choosePlanButton('celebration_pass'));

    expect(choosePlanButton('celebration_pass')).toHaveTextContent(i18n.t('pricing.upgrading'));
    expect(choosePlanButton('deluxe_keepsake')).toBeDisabled();
    expect(choosePlanButton('pro_planner')).toBeDisabled();

    await act(async () => {
      resolveUpgrade();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('shows the server error and re-enables plan selection when the upgrade fails', async () => {
    const onUpgradePlan = vi.fn().mockRejectedValue(new Error('Payment gateway unreachable'));
    const onClose = vi.fn();
    render(
      <PricingPlansModal isOpen onClose={onClose} currentPlanTier="free" onUpgradePlan={onUpgradePlan} />
    );

    await act(async () => {
      fireEvent.click(choosePlanButton('celebration_pass'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Payment gateway unreachable');
    expect(onClose).not.toHaveBeenCalled();
    expect(confetti).not.toHaveBeenCalled();

    // Selection is available again, not stuck disabled from the failed attempt.
    expect(choosePlanButton('deluxe_keepsake')).not.toBeDisabled();
  });

  it('redirects to a real Stripe Checkout URL instead of the self-serve write when Stripe is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockFetchResponse(200, { url: 'https://checkout.stripe.com/c/pay/cs_test_123' }))
    );
    const onUpgradePlan = vi.fn().mockResolvedValue(undefined);
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, set href(v: string) { hrefSetter(v); } },
      writable: true,
    });

    render(<PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="free" onUpgradePlan={onUpgradePlan} />);

    await act(async () => {
      fireEvent.click(choosePlanButton('celebration_pass'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hrefSetter).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_123');
    // The real path never touches the direct tier-write fallback.
    expect(onUpgradePlan).not.toHaveBeenCalled();
  });

  it('surfaces a genuine checkout error directly instead of silently falling back to self-serve', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockFetchResponse(500, { error: 'Failed to start checkout' }))
    );
    const onUpgradePlan = vi.fn().mockResolvedValue(undefined);

    render(<PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="free" onUpgradePlan={onUpgradePlan} />);

    await act(async () => {
      fireEvent.click(choosePlanButton('celebration_pass'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to start checkout');
    // A real, unexplained checkout failure must not silently downgrade to
    // the unpaid self-serve write - only a confirmed "not configured" does.
    expect(onUpgradePlan).not.toHaveBeenCalled();
  });

  it('never attempts a checkout session for the free tier — a downgrade needs no payment step', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(503, { code: 'STRIPE_NOT_CONFIGURED' }));
    vi.stubGlobal('fetch', fetchSpy);
    const onUpgradePlan = vi.fn().mockResolvedValue(undefined);

    render(
      <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="celebration_pass" onUpgradePlan={onUpgradePlan} />
    );

    await act(async () => {
      fireEvent.click(choosePlanButton('free'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onUpgradePlan).toHaveBeenCalledWith('free');
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<PricingPlansModal isOpen onClose={onClose} currentPlanTier="free" onUpgradePlan={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons.find((b) => b.querySelector('svg.lucide-x'))!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
