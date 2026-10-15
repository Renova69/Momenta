import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { WeddingEvent } from '../../src/types';

/**
 * The pricing table and the events switcher are host dialogs a guest never
 * opens. Mounted closed, a lazy component still fetches its chunk, so every
 * guest's phone downloaded both on the album page (§3e, "found and not yet
 * acted on"). Each must be fetched the first time it opens, and not before.
 *
 * A mock factory runs when its module is first imported, which for a lazy
 * component is the moment the chunk would be requested.
 */
const fetched = vi.hoisted(() => ({ pricing: 0, eventsList: 0 }));

vi.mock('../../src/components/host/PricingPlansModal', () => {
  fetched.pricing += 1;
  return {
    PricingPlansModal: ({ isOpen }: { isOpen: boolean }) =>
      isOpen ? <div role="dialog" aria-label="pricing" /> : null,
  };
});

vi.mock('../../src/components/host/HostEventsList', () => {
  fetched.eventsList += 1;
  return {
    HostEventsList: ({ isOpen }: { isOpen: boolean }) =>
      isOpen ? <div role="dialog" aria-label="my events" /> : null,
  };
});

import { HostDialogs } from '../../src/components/host/HostDialogs';

const EVENT = { id: 'e1', slug: 'ana-i-boris', planTier: 'free' } as WeddingEvent;

function dialogs(open: { pricing?: boolean; eventsList?: boolean } = {}) {
  return (
    <HostDialogs
      event={EVENT}
      isPricingOpen={!!open.pricing}
      onClosePricing={vi.fn()}
      onUpgradePlan={vi.fn().mockResolvedValue(undefined)}
      isEventsListOpen={!!open.eventsList}
      onCloseEventsList={vi.fn()}
      onSelectEvent={vi.fn()}
      onCreateEvent={vi.fn().mockResolvedValue(undefined)}
      onOpenPricingFromList={vi.fn()}
    />
  );
}

/** Long enough for a dynamic import that was started to resolve. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('host dialogs on a guest page', () => {
  beforeEach(() => {
    fetched.pricing = 0;
    fetched.eventsList = 0;
  });

  it('fetches neither dialog while both are closed', async () => {
    render(dialogs());
    await settle();

    expect(fetched).toEqual({ pricing: 0, eventsList: 0 });
  });

  it('fetches the pricing table when it opens, and shows it', async () => {
    const { rerender } = render(dialogs());
    await settle();

    rerender(dialogs({ pricing: true }));

    expect(await screen.findByRole('dialog', { name: 'pricing' })).toBeInTheDocument();
    expect(fetched.eventsList).toBe(0);
  });

  it('fetches the events switcher when it opens, and shows it', async () => {
    const { rerender } = render(dialogs());
    await settle();

    rerender(dialogs({ eventsList: true }));

    expect(await screen.findByRole('dialog', { name: 'my events' })).toBeInTheDocument();
  });
});
