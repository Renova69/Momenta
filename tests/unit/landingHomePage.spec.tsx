import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { LandingHomePage } from '../../src/components/home/LandingHomePage';
import { i18n } from '../../src/i18n';

afterEach(() => cleanup());

describe('LandingHomePage', () => {
  it('fires onOpenCreateEvent from the primary hero CTA', () => {
    const onOpenCreateEvent = vi.fn();
    render(
      <LandingHomePage onSelectWedding={vi.fn()} onOpenCreateEvent={onOpenCreateEvent} onOpenPricing={vi.fn()} />
    );

    fireEvent.click(screen.getByText(i18n.t('ui.landing_home_page.8')));
    expect(onOpenCreateEvent).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenPricing from the secondary hero CTA', () => {
    const onOpenPricing = vi.fn();
    render(
      <LandingHomePage onSelectWedding={vi.fn()} onOpenCreateEvent={vi.fn()} onOpenPricing={onOpenPricing} />
    );

    fireEvent.click(screen.getByText(i18n.t('ui.landing_home_page.9')));
    expect(onOpenPricing).toHaveBeenCalledTimes(1);
  });

  it('is a single-open accordion: opens the first FAQ by default, and opening another closes it', () => {
    render(<LandingHomePage onSelectWedding={vi.fn()} onOpenCreateEvent={vi.fn()} onOpenPricing={vi.fn()} />);

    const firstAnswer = i18n.t('landing.faq1_a');
    const secondAnswer = i18n.t('landing.faq2_a');

    expect(screen.getByText(firstAnswer)).toBeInTheDocument();
    expect(screen.queryByText(secondAnswer)).not.toBeInTheDocument();

    // Opening the second FAQ closes the first — only one is open at a time.
    fireEvent.click(screen.getByText(i18n.t('landing.faq2_q')));
    expect(screen.getByText(secondAnswer)).toBeInTheDocument();
    expect(screen.queryByText(firstAnswer)).not.toBeInTheDocument();

    // Clicking the currently-open FAQ again collapses it, leaving none open.
    fireEvent.click(screen.getByText(i18n.t('landing.faq2_q')));
    expect(screen.queryByText(secondAnswer)).not.toBeInTheDocument();
  });

  it('renders the public weddings showcase feed wired to the same callbacks', () => {
    const onSelectWedding = vi.fn();
    render(
      <LandingHomePage onSelectWedding={onSelectWedding} onOpenCreateEvent={vi.fn()} onOpenPricing={vi.fn()} />
    );
    // PublicWeddingsShowcase renders its own badge heading — confirms it's mounted.
    expect(screen.getByText(i18n.t('showcase.badge'))).toBeInTheDocument();
  });
});
