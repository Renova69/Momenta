import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

import { BillingNotice } from '../../src/components/host/BillingNotice';
import { i18n } from '../../src/i18n';

/**
 * N-152 — when a renewal fails, Stripe retries and the plan is kept until a
 * deadline, then dropped. Nothing told the host: no email can be sent while
 * SMTP is unset, and the studio looked like any paid-up plan. The notice is
 * the one place the host can learn it in time, and the way to fix the card.
 */

function respond(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BillingNotice', () => {
  it('says when the plan ends after a failed payment, and offers to update the card', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ tier: 'pro_planner', paymentFailed: true, planEndsAt: '2026-10-23T13:49:55.000Z' }))
    );

    render(<BillingNotice eventSlug="ana-i-boris" />);

    expect(await screen.findByText(i18n.t('billing.payment_failed', { date: '23.10.2026' }))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('billing.update_card') })).toBeInTheDocument();
  });

  it('says a suspended plan comes back once the card is updated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ tier: 'free', paymentFailed: false, planEndsAt: null, planSuspended: true }))
    );

    render(<BillingNotice eventSlug="ana-i-boris" />);

    expect(await screen.findByText(i18n.t('billing.plan_suspended'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('billing.update_card') })).toBeInTheDocument();
  });

  it('shows nothing for a plan that is paid up', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(respond({ tier: 'pro_planner', paymentFailed: false, planEndsAt: null }));
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<BillingNotice eventSlug="ana-i-boris" />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('stays out of the way when the status cannot be read', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<BillingNotice eventSlug="ana-i-boris" />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the billing portal, returning to this album', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(respond({ tier: 'pro_planner', paymentFailed: true, planEndsAt: '2026-10-23T13:49:55.000Z' }))
      .mockResolvedValueOnce(respond({ error: 'Stripe unreachable' }, 500));
    vi.stubGlobal('fetch', fetchSpy);

    render(<BillingNotice eventSlug="ana-i-boris" />);
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('billing.update_card') }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('/api/billing/portal-session');
    expect(JSON.parse(init.body as string).returnUrl).toContain('event=ana-i-boris');
    // The portal failing to open is said, not swallowed.
    expect(await screen.findByText(i18n.t('billing.portal_failed'))).toBeInTheDocument();
  });
});
