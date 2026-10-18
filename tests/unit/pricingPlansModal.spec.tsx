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
    const checkoutFetch = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(200, { url: 'https://checkout.stripe.com/c/pay/cs_test_123' }));
    vi.stubGlobal('fetch', checkoutFetch);
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
    // And the return page is told which plan to wait for (N-54), in the URL
    // Stripe sends the host back to.
    const sent = JSON.parse(String(checkoutFetch.mock.calls[0][1].body));
    expect(new URL(sent.successUrl).searchParams.get('tier')).toBe('celebration_pass');
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

    // N-125 — said in the app's language; the server's English
    // "Failed to start checkout" reached a Bulgarian host as-is.
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('error.server'));
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

    // Through the confirmation N-51 added: a paid plan is not given up on one click.
    fireEvent.click(choosePlanButton('free'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('pricing.confirm_free_switch') }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onUpgradePlan).toHaveBeenCalledWith('free');
  });

  // N-51 — a host on a one-time pass gave it up with one unconfirmed click on
  // the Free card, and the modal fired confetti for it. The pass was paid for
  // once, is not refunded, and does not come back.
  describe('giving up a paid plan (N-51)', () => {
    const passName = () => i18n.t(PLANS.deluxe_keepsake.name);

    it('asks first, naming the plan, and changes nothing until the host confirms', () => {
      const onUpgradePlan = vi.fn().mockResolvedValue(undefined);
      render(
        <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="deluxe_keepsake" onUpgradePlan={onUpgradePlan} />
      );

      fireEvent.click(choosePlanButton('free'));

      expect(onUpgradePlan).not.toHaveBeenCalled();
      expect(screen.getByText(i18n.t('pricing.confirm_free_title', { plan: passName() }))).toBeInTheDocument();
    });

    // N-164 — a subscriber who bought a one-time pass first keeps it when
    // the subscription ends; the question said they would lose everything.
    it('names the one-time pass a subscriber keeps, rather than promising Free', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          mockFetchResponse(200, { tier: 'pro_planner', paymentFailed: false, planEndsAt: null, keepsTier: 'celebration_pass' })
        )
      );
      render(<PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="pro_planner" onUpgradePlan={vi.fn()} />);

      fireEvent.click(choosePlanButton('free'));

      const pro = i18n.t(PLANS.pro_planner.name);
      const kept = i18n.t(PLANS.celebration_pass.name);
      expect(await screen.findByText(i18n.t('pricing.confirm_free_title_keeps', { plan: pro, kept }))).toBeInTheDocument();
      expect(screen.getByText(i18n.t('pricing.confirm_free_body_keeps', { kept }))).toBeInTheDocument();
    });

    it('keeps the plan when the host backs out', () => {
      const onUpgradePlan = vi.fn().mockResolvedValue(undefined);
      render(
        <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="deluxe_keepsake" onUpgradePlan={onUpgradePlan} />
      );

      fireEvent.click(choosePlanButton('free'));
      fireEvent.click(screen.getByRole('button', { name: i18n.t('pricing.confirm_free_keep', { plan: passName() }) }));

      expect(onUpgradePlan).not.toHaveBeenCalled();
      expect(screen.queryByText(i18n.t('pricing.confirm_free_title', { plan: passName() }))).not.toBeInTheDocument();
    });

    it('moves focus to the safe choice when it asks', () => {
      render(
        <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="deluxe_keepsake" onUpgradePlan={vi.fn()} />
      );

      fireEvent.click(choosePlanButton('free'));

      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: i18n.t('pricing.confirm_free_keep', { plan: passName() }) })
      );
    });

    it('does not reopen still asking, after being closed mid-question', () => {
      const props = { onClose: vi.fn(), currentPlanTier: 'deluxe_keepsake' as PlanTier, onUpgradePlan: vi.fn() };
      const { rerender } = render(<PricingPlansModal isOpen {...props} />);
      fireEvent.click(choosePlanButton('free'));

      rerender(<PricingPlansModal isOpen={false} {...props} />);
      rerender(<PricingPlansModal isOpen {...props} />);

      expect(screen.queryByText(i18n.t('pricing.confirm_free_title', { plan: passName() }))).not.toBeInTheDocument();
    });

    it('switches once confirmed, without celebrating it', async () => {
      const onUpgradePlan = vi.fn().mockResolvedValue(undefined);
      render(
        <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="deluxe_keepsake" onUpgradePlan={onUpgradePlan} />
      );

      fireEvent.click(choosePlanButton('free'));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: i18n.t('pricing.confirm_free_switch') }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onUpgradePlan).toHaveBeenCalledWith('free');
      expect(confetti).not.toHaveBeenCalled();
    });
  });

  /**
   * N-155 — a Pro Planner host was offered "Choose plan" on both one-time
   * passes, which the server then refused as already included.
   */
  it('shows the plans the current one already includes as included, not for sale', () => {
    render(
      <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="pro_planner" onUpgradePlan={vi.fn()} />
    );

    for (const tier of ['celebration_pass', 'deluxe_keepsake'] as PlanTier[]) {
      expect(choosePlanButton(tier)).toBeDisabled();
      expect(choosePlanButton(tier)).toHaveTextContent(i18n.t('pricing.included'));
    }
  });

  it('still offers a higher plan, and the free one', () => {
    render(
      <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="celebration_pass" onUpgradePlan={vi.fn()} />
    );

    expect(choosePlanButton('deluxe_keepsake')).toBeEnabled();
    expect(choosePlanButton('free')).toBeEnabled();
  });

  /**
   * N-151 — opened from a guest's phone, choosing a plan went to checkout
   * without a session and came back as "Unauthorized: Missing or invalid
   * token". A visitor is sent to sign in instead, and no plan is "theirs".
   */
  describe('for a visitor who is not signed in', () => {
    it('sends them to sign in instead of starting a checkout', () => {
      const onSignInRequired = vi.fn();
      render(
        <PricingPlansModal
          isOpen
          onClose={vi.fn()}
          currentPlanTier="celebration_pass"
          onUpgradePlan={vi.fn()}
          onSignInRequired={onSignInRequired}
        />
      );

      fireEvent.click(choosePlanButton('deluxe_keepsake'));

      expect(onSignInRequired).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('marks no plan as theirs: the album’s plan is the couple’s, not the visitor’s', () => {
      render(
        <PricingPlansModal
          isOpen
          onClose={vi.fn()}
          currentPlanTier="celebration_pass"
          onUpgradePlan={vi.fn()}
          onSignInRequired={vi.fn()}
        />
      );

      for (const tier of Object.keys(PLANS) as PlanTier[]) {
        expect(choosePlanButton(tier)).toBeEnabled();
        expect(choosePlanButton(tier)).toHaveTextContent(i18n.t('pricing.choose_plan'));
      }
    });
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<PricingPlansModal isOpen onClose={onClose} currentPlanTier="free" onUpgradePlan={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons.find((b) => b.querySelector('svg.lucide-x'))!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// One wedding per pass (2026-10-18): once the album a pass was bought for has
// closed, the pass is spent, and buying one again is what reopens the album.
// The dialog used to call that pass "current" and refuse it.
describe('a closed album', () => {
  it('offers its pass again, since buying one is what reopens it', () => {
    render(
      <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="celebration_pass" albumClosed onUpgradePlan={vi.fn()} />
    );

    for (const tier of ['celebration_pass', 'deluxe_keepsake'] as PlanTier[]) {
      const button = choosePlanButton(tier);
      expect(button).not.toBeDisabled();
      expect(button).toHaveTextContent(i18n.t('pricing.choose_plan'));
    }
  });

  it('still calls a subscription current: a Pro Planner album never closes', () => {
    render(
      <PricingPlansModal isOpen onClose={vi.fn()} currentPlanTier="pro_planner" albumClosed onUpgradePlan={vi.fn()} />
    );
    expect(choosePlanButton('pro_planner')).toHaveTextContent(i18n.t('pricing.current_plan'));
  });
});
