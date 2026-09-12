import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

import { StorageMeter } from '../../src/components/host/StorageMeter';
import { ReactionBar } from '../../src/components/gallery/ReactionBar';
import { LockedFeatureCard, LockedFeatureBadge } from '../../src/components/common/LockedFeatureBadge';
import { ErrorBoundary } from '../../src/components/common/ErrorBoundary';
import { PublicWeddingsShowcase } from '../../src/components/home/PublicWeddingsShowcase';
import { QRCanvasStudio } from '../../src/components/host/QRCanvasStudio';
import { eventsApi, EventUsage } from '../../src/api/eventsApi';
import { WeddingEvent, QRCanvasConfig } from '../../src/types';
import { storageService } from '../../src/services/storageService';
import { i18n } from '../../src/i18n';

const EVENT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

function usage(overrides: Partial<EventUsage> = {}): EventUsage {
  return {
    tier: 'free',
    usedBytes: 0,
    limitBytes: 536_870_912,
    usedLabel: '0 MB',
    limitLabel: '512 MB',
    percentUsed: 0,
    pooled: false,
    photoCount: 0,
    maxPhotos: 50,
    expiresAt: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('StorageMeter', () => {
  it('shows the plan position once usage loads', async () => {
    vi.spyOn(eventsApi, 'getUsage').mockResolvedValue(
      usage({ usedBytes: 1024, usedLabel: '250 MB', percentUsed: 49 })
    );

    render(<StorageMeter eventId={EVENT_ID} />);

    expect(await screen.findByText('250 MB / 512 MB')).toBeInTheDocument();

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '49');
  });

  it('warns before the album runs out of space, and offers the upgrade', async () => {
    const onOpenPricing = vi.fn();
    vi.spyOn(eventsApi, 'getUsage').mockResolvedValue(
      usage({ percentUsed: 92, usedLabel: '470 MB' })
    );

    render(<StorageMeter eventId={EVENT_ID} onOpenPricing={onOpenPricing} />);

    const warning = await screen.findByText(i18n.t('storage.nearly_full'));
    fireEvent.click(warning);
    expect(onOpenPricing).toHaveBeenCalled();
  });

  it('says uploads will be refused once the allowance is spent', async () => {
    vi.spyOn(eventsApi, 'getUsage').mockResolvedValue(usage({ percentUsed: 100 }));

    render(<StorageMeter eventId={EVENT_ID} />);
    expect(await screen.findByText(i18n.t('storage.full'))).toBeInTheDocument();
  });

  it('surfaces the retention deadline when the album has one', async () => {
    const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString();
    vi.spyOn(eventsApi, 'getUsage').mockResolvedValue(usage({ expiresAt: inTenDays }));

    render(<StorageMeter eventId={EVENT_ID} />);

    expect(
      await screen.findByText(new RegExp(i18n.t('storage.archive_until')))
    ).toBeInTheDocument();
    expect(screen.getByText(/10 /)).toBeInTheDocument();
  });

  it('renders nothing rather than an error when usage cannot be read', async () => {
    vi.spyOn(eventsApi, 'getUsage').mockRejectedValue(new Error('403'));

    const { container } = render(<StorageMeter eventId={EVENT_ID} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('ReactionBar', () => {
  beforeEach(() => {
    vi.spyOn(storageService, 'sendReaction').mockImplementation(() => undefined);
  });

  it('sends the tapped reaction with the guest name', () => {
    render(<ReactionBar guestName="Silvia" />);

    fireEvent.click(screen.getByLabelText(i18n.t('reaction.cheers')));

    expect(storageService.sendReaction).toHaveBeenCalledWith('cheers', 'Silvia');
  });

  it('caps rapid taps at 5 reactions per second (P6)', () => {
    render(<ReactionBar guestName="Silvia" />);
    const heart = screen.getByLabelText(i18n.t('reaction.heart'));

    for (let i = 0; i < 8; i++) {
      fireEvent.click(heart);
    }

    // The 6th-8th taps land inside the same second as the first 5 — dropped
    // at the source rather than all reaching the network (a guest tapping
    // as fast as physically possible was the actual P6 flood vector, not
    // just a scripted attacker).
    expect(storageService.sendReaction).toHaveBeenCalledTimes(5);
  });

  it('allows another tap once the rate window has passed', () => {
    vi.useFakeTimers();
    try {
      render(<ReactionBar guestName="Silvia" />);
      const heart = screen.getByLabelText(i18n.t('reaction.heart'));

      for (let i = 0; i < 5; i++) fireEvent.click(heart);
      expect(storageService.sendReaction).toHaveBeenCalledTimes(5);

      vi.advanceTimersByTime(1100);
      fireEvent.click(heart);

      expect(storageService.sendReaction).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers every reaction the server accepts', () => {
    render(<ReactionBar />);

    for (const kind of ['heart', 'clap', 'cheers', 'laugh', 'party']) {
      expect(screen.getByLabelText(i18n.t(`reaction.${kind}`))).toBeInTheDocument();
    }
  });
});

describe('LockedFeatureBadge', () => {
  it('names the plan a locked feature needs', () => {
    render(<LockedFeatureCard feature="audio_guestbook" />);

    // Deluxe Keepsake gates the audio guestbook.
    expect(screen.getByText(i18n.t('gate.audio_guestbook.title'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('gate.audio_guestbook.desc'))).toBeInTheDocument();
  });

  it('invites the host to upgrade', () => {
    const onOpenPricing = vi.fn();
    render(<LockedFeatureCard feature="live_tv" onOpenPricing={onOpenPricing} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onOpenPricing).toHaveBeenCalled();
  });

  it('renders a compact badge for inline use', () => {
    const { container } = render(<LockedFeatureBadge feature="zip_export" compact />);
    expect(container.firstChild).not.toBeNull();
  });
});

describe('ErrorBoundary', () => {
  it('catches a render failure instead of blanking the app', () => {
    // React logs the caught error; silence it so the run stays readable.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const Boom = () => {
      throw new Error('render exploded');
    };

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    // A guest sees a recovery message, not an internal error string. The raw
    // message is dev-only.
    expect(screen.getByText(i18n.t('common.error_body'))).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the album is fine</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('the album is fine')).toBeInTheDocument();
  });
});

describe('PublicWeddingsShowcase (FE-09)', () => {
  afterEach(() => {
    i18n.setLanguage('bg');
  });

  it('renders its UI chrome through i18n, not hardcoded Bulgarian', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockRejectedValue(new Error('offline in test'));

    render(
      <PublicWeddingsShowcase
        onSelectWedding={() => {}}
        onOpenCreateEvent={() => {}}
        onOpenPricing={() => {}}
      />
    );

    expect(screen.getByText(i18n.t('showcase.title'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('showcase.cta_title'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('showcase.create_album_button'))).toBeInTheDocument();

    // Switching language actually changes the rendered text — the tell for
    // real i18n wiring rather than a hardcoded Bulgarian string that just
    // happens to match i18n.t()'s own Bulgarian default (bg is the app's
    // default language, so a hardcoded Bulgarian string passes a bg-only
    // check for the wrong reason). Every converted string gets its own
    // check here so a regression on any one of them is caught.
    i18n.setLanguage('en');
    cleanup();
    render(
      <PublicWeddingsShowcase
        onSelectWedding={() => {}}
        onOpenCreateEvent={() => {}}
        onOpenPricing={() => {}}
      />
    );
    expect(screen.getByText('Live weddings on WedMoments')).toBeInTheDocument();
    expect(screen.getByText('Real memories from our couples')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Browse wedding albums in real time, captured by guests on their phones. Every photo uploads instantly and comes alive on the big screen.'
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText('Active album').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Shots from the event:').length).toBeGreaterThan(0);
    expect(screen.getByText('Get started for free')).toBeInTheDocument();
    expect(screen.getByText('Planning your dream wedding?')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Create a digital album in 2 minutes. Your guests scan a QR code from the table and share photos live straight to the projector or big-screen TV!'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Create a wedding album')).toBeInTheDocument();
    expect(screen.getByText('See pricing plans')).toBeInTheDocument();

    expect(screen.queryByText('Организирате вашата мечтана сватба?')).not.toBeInTheDocument();
  });
});

describe('QRCanvasStudio (FE-10)', () => {
  afterEach(() => {
    i18n.setLanguage('bg');
  });

  it('formats the live date preview in the active language, not a hardcoded bg-BG locale', () => {
    const event: WeddingEvent = {
      id: 'event-fe10',
      slug: 'fe10-spec',
      title: 'FE-10 Spec Wedding',
      hostName: 'Spec Host',
      hostEmail: 'fe10@test.com',
      eventDate: '2026-09-18',
      venueName: 'Spec Venue',
      coverImageUrl: '',
      themePalette: 'champagne_gold',
      welcomeMessage: '',
      isModerationEnabled: false,
      isDisposableMode: false,
      isPublic: false,
      revealAt: null,
      maxPhotosPerGuest: 50,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const config: QRCanvasConfig = {
      id: 'qr-fe10',
      eventId: event.id,
      canvasSize: 'A2',
      frameStyle: 'minimal_gold',
      headline: 'Headline',
      subtext: 'Subtext',
      accentColor: '#D4AF37',
      centerIcon: 'heart',
    };

    // Bulgarian (the app default) keeps its own long-form date.
    render(<QRCanvasStudio event={event} config={config} onUpdateConfig={() => {}} />);
    expect(screen.getByText(/18 септември 2026/)).toBeInTheDocument();

    // Switching language changes the rendered month name — a value hardcoded
    // to 'bg-BG' would keep showing the Bulgarian month regardless.
    i18n.setLanguage('en');
    cleanup();
    render(<QRCanvasStudio event={event} config={config} onUpdateConfig={() => {}} />);
    expect(screen.getByText(/18 September 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/септември/)).not.toBeInTheDocument();
  });
});
