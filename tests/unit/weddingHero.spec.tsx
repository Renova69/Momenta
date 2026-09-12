import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { WeddingHero } from '../../src/components/layout/WeddingHero';
import { WeddingEvent, Guest, Photo, ScavengerQuest, AudioGuestbookEntry } from '../../src/types';
import { i18n } from '../../src/i18n';

function makeEvent(overrides: Partial<WeddingEvent> = {}): WeddingEvent {
  return {
    id: 'e1',
    slug: 'monika-and-alexander-2026',
    title: 'Monika & Alexander',
    hostName: 'Monika & Alexander',
    hostEmail: 'host@example.com',
    eventDate: '2026-09-18T16:30:00.000Z',
    venueName: 'Villa Bояна',
    coverImageUrl: 'https://cdn.example/cover.jpg',
    themePalette: 'champagne_gold',
    welcomeMessage: 'Welcome to our big day!',
    planTier: 'free',
    isModerationEnabled: false,
    isDisposableMode: false,
    isPublic: false,
    revealAt: null,
    maxPhotosPerGuest: 50,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function photo(status: Photo['status']): Photo {
  return {
    id: `p-${Math.random().toString(36).slice(2, 8)}`,
    eventId: 'e1',
    guestId: 'g1',
    guestName: 'Silvia',
    storagePath: '/uploads/x.jpg',
    thumbnailUrl: 'https://cdn.example/x-thumb.jpg',
    fullUrl: 'https://cdn.example/x.jpg',
    status,
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    likedByGuestIds: [],
    comments: [],
    createdAt: new Date().toISOString(),
  } as Photo;
}

function quest(completedByGuestIds: string[]): ScavengerQuest {
  return {
    id: `q-${Math.random().toString(36).slice(2, 8)}`,
    eventId: 'e1',
    title: 'Dance floor',
    description: '',
    iconName: 'camera',
    points: 10,
    isActive: true,
    completedByGuestIds,
  };
}

const NO_QUESTS: ScavengerQuest[] = [];
const NO_AUDIO: AudioGuestbookEntry[] = [];
const NO_GUESTS: Guest[] = [];

afterEach(() => cleanup());

describe('WeddingHero', () => {
  it('shows the couple names, date, venue, and welcome message', () => {
    render(
      <WeddingHero
        event={makeEvent()}
        guests={NO_GUESTS}
        photos={[]}
        quests={NO_QUESTS}
        audioEntries={NO_AUDIO}
        onOpenCapture={vi.fn()}
        onOpenAudio={vi.fn()}
        onOpenQuests={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { name: 'Monika & Alexander' })).toBeInTheDocument();
    expect(screen.getByText('Villa Bояна')).toBeInTheDocument();
    expect(screen.getByText('"Welcome to our big day!"')).toBeInTheDocument();
  });

  it('counts only approved/featured photos, not pending or rejected', () => {
    const photos = [photo('approved'), photo('featured'), photo('pending'), photo('rejected')];
    render(
      <WeddingHero
        event={makeEvent()}
        guests={NO_GUESTS}
        photos={photos}
        quests={NO_QUESTS}
        audioEntries={NO_AUDIO}
        onOpenCapture={vi.fn()}
        onOpenAudio={vi.fn()}
        onOpenQuests={vi.fn()}
      />
    );

    const label = screen.getByText(i18n.t('hero.moments_captured'));
    // The count sits in a sibling span right before the label.
    expect(label.parentElement).toHaveTextContent('2');
  });

  it('counts a quest as completed once at least one guest has finished it', () => {
    const quests = [quest(['g1']), quest([]), quest(['g2', 'g3'])];
    render(
      <WeddingHero
        event={makeEvent()}
        guests={NO_GUESTS}
        photos={[]}
        quests={quests}
        audioEntries={NO_AUDIO}
        onOpenCapture={vi.fn()}
        onOpenAudio={vi.fn()}
        onOpenQuests={vi.fn()}
      />
    );

    expect(screen.getByText(`${i18n.t('feed.quests')} (2/3)`)).toBeInTheDocument();
  });

  it('shows locked badges for gated features on the free tier, and hides them once unlocked', () => {
    const { rerender } = render(
      <WeddingHero
        event={makeEvent({ planTier: 'free' })}
        guests={NO_GUESTS}
        photos={[]}
        quests={NO_QUESTS}
        audioEntries={NO_AUDIO}
        onOpenCapture={vi.fn()}
        onOpenAudio={vi.fn()}
        onOpenQuests={vi.fn()}
      />
    );
    // Free tier: both scavenger quests (needs celebration_pass) and audio
    // guestbook (needs deluxe_keepsake) are locked.
    expect(document.querySelectorAll('svg.lucide-lock').length).toBe(2);

    rerender(
      <WeddingHero
        event={makeEvent({ planTier: 'deluxe_keepsake' })}
        guests={NO_GUESTS}
        photos={[]}
        quests={NO_QUESTS}
        audioEntries={NO_AUDIO}
        onOpenCapture={vi.fn()}
        onOpenAudio={vi.fn()}
        onOpenQuests={vi.fn()}
      />
    );
    expect(document.querySelectorAll('svg.lucide-lock').length).toBe(0);
  });

  it('fires the capture/quests/audio callbacks from their buttons', () => {
    const onOpenCapture = vi.fn();
    const onOpenQuests = vi.fn();
    const onOpenAudio = vi.fn();
    render(
      <WeddingHero
        event={makeEvent()}
        guests={NO_GUESTS}
        photos={[]}
        quests={NO_QUESTS}
        audioEntries={NO_AUDIO}
        onOpenCapture={onOpenCapture}
        onOpenAudio={onOpenAudio}
        onOpenQuests={onOpenQuests}
      />
    );

    fireEvent.click(screen.getByText(i18n.t('hero.take_photo')));
    expect(onOpenCapture).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText(new RegExp(i18n.t('feed.quests'))));
    expect(onOpenQuests).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText(new RegExp(i18n.t('hero.audio_toast'))));
    expect(onOpenAudio).toHaveBeenCalledTimes(1);
  });
});
