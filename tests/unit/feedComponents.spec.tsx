import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { LiveFeed } from '../../src/components/gallery/LiveFeed';
import { PhotoCard } from '../../src/components/gallery/PhotoCard';
import { ScavengerHunt } from '../../src/components/quests/ScavengerHunt';
import { Photo, Guest, ScavengerQuest, PhotoComment } from '../../src/types';
import { i18n } from '../../src/i18n';

const ME: Guest = {
  id: 'guest-me',
  eventId: 'e1',
  name: 'Silvia',
  createdAt: new Date().toISOString(),
};

const ANONYMOUS: Guest = { ...ME, id: 'anonymous', name: 'Guest' };

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: `p-${Math.random().toString(36).slice(2, 8)}`,
    eventId: 'e1',
    guestId: 'guest-other',
    guestName: 'Martin',
    storagePath: '/uploads/x.jpg',
    thumbnailUrl: 'https://cdn.example/x-thumb.jpg',
    fullUrl: 'https://cdn.example/x.jpg',
    status: 'approved',
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    likedByGuestIds: [],
    comments: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Photo;
}

function renderFeed(photos: Photo[], guest: Guest = ME, extra: Record<string, unknown> = {}) {
  return render(
    <LiveFeed
      photos={photos}
      currentGuest={guest}
      onLike={vi.fn()}
      onReact={vi.fn()}
      onOpenComments={vi.fn()}
      onOpenLightbox={vi.fn()}
      onOpenCapture={vi.fn()}
      {...extra}
    />
  );
}

/** Click a filter tab by its translated label, ignoring the trailing count. */
function clickFilter(key: string) {
  const label = i18n.t(key);
  const button = screen.getAllByRole('button').find((b) => (b.textContent || '').includes(label));
  if (!button) throw new Error(`filter button not found: ${label}`);
  fireEvent.click(button);
}

/** Captions are rendered in quotes by PhotoCard, so they identify a card. */
function shows(text: string): boolean {
  return screen.queryAllByText(new RegExp(text)).length > 0;
}

afterEach(cleanup);

describe('LiveFeed visibility rules', () => {
  it('hides other guests pending photos but shows the viewer their own', () => {
    const mine = photo({ guestId: ME.id, guestName: 'Silvia', caption: 'my pending shot', status: 'pending' });
    const theirs = photo({ guestId: 'guest-other', caption: 'their pending shot', status: 'pending' });
    const approved = photo({ caption: 'an approved shot', status: 'approved' });

    renderFeed([mine, theirs, approved]);

    // A guest awaiting moderation still sees their own upload; another guest's
    // pending photo must not leak.
    expect(shows('my pending shot')).toBe(true);
    expect(shows('their pending shot')).toBe(false);
    expect(shows('an approved shot')).toBe(true);
  });

  it('never treats photos as "mine" for an anonymous viewer', () => {
    // Matching on name instead of id would leak every "Guest" photo to everyone.
    const pendingFromSomeone = photo({
      guestId: 'someone',
      guestName: 'Guest',
      caption: 'someone elses pending',
      status: 'pending',
    });

    renderFeed([pendingFromSomeone], ANONYMOUS);
    expect(shows('someone elses pending')).toBe(false);
  });

  it('filters to featured photos only', () => {
    const featured = photo({ caption: 'the featured one', status: 'featured' });
    const ordinary = photo({ caption: 'the ordinary one', status: 'approved' });

    renderFeed([featured, ordinary]);
    clickFilter('feed.featured');

    expect(shows('the featured one')).toBe(true);
    expect(shows('the ordinary one')).toBe(false);
  });

  it('filters to quest photos only', () => {
    const questShot = photo({ questId: 'quest-1', questTitle: 'First kiss', caption: 'quest capture' });
    const plain = photo({ caption: 'plain capture' });

    renderFeed([questShot, plain]);
    clickFilter('feed.quests');

    expect(shows('quest capture')).toBe(true);
    expect(shows('plain capture')).toBe(false);
  });

  it('searches across guest name, caption and quest title', () => {
    const byCaption = photo({ caption: 'Cutting the cake' });
    const byQuest = photo({ questId: 'x', questTitle: 'Champagne toast', caption: 'toast shot' });
    const byName = photo({ guestName: 'Martin', caption: 'Dancing hard' });

    renderFeed([byCaption, byQuest, byName]);
    const search = screen.getByPlaceholderText(i18n.t('feed.search_placeholder'));

    fireEvent.change(search, { target: { value: 'cake' } });
    expect(shows('Cutting the cake')).toBe(true);
    expect(shows('Dancing hard')).toBe(false);

    // Quest title matches even though the caption does not mention it.
    fireEvent.change(search, { target: { value: 'champagne' } });
    expect(shows('toast shot')).toBe(true);

    fireEvent.change(search, { target: { value: 'martin' } });
    expect(shows('Dancing hard')).toBe(true);
  });

  it('warns a free-tier album as it approaches the photo cap', () => {
    const photos = Array.from({ length: 45 }, (_, i) => photo({ id: `p${i}` }));

    renderFeed(photos, ME, { eventPlanTier: 'free', onOpenPricing: vi.fn() });

    // 45 of 50 — the host should hear about it before uploads start failing.
    expect(screen.getByText(/45\s*\/\s*50/)).toBeInTheDocument();
  });

  it('says nothing about limits on a paid plan', () => {
    const photos = Array.from({ length: 60 }, (_, i) => photo({ id: `p${i}` }));

    renderFeed(photos, ME, { eventPlanTier: 'celebration_pass' });
    expect(screen.queryByText(/\/\s*50/)).not.toBeInTheDocument();
  });
});

describe('ScavengerHunt', () => {
  function quest(overrides: Partial<ScavengerQuest> = {}): ScavengerQuest {
    return {
      id: `q-${Math.random().toString(36).slice(2, 7)}`,
      eventId: 'e1',
      title: 'First kiss',
      description: 'Catch the moment',
      iconName: 'heart',
      points: 15,
      isActive: true,
      completedByGuestIds: [],
      ...overrides,
    } as ScavengerQuest;
  }

  it('renders an icon for every name the seed data uses', () => {
    // 'users' was missing from the icon map, so the seeded group-selfie quest
    // silently fell back to a camera.
    const quests = ['heart', 'music', 'smile', 'camera', 'wine', 'users'].map((iconName) =>
      quest({ iconName, title: `Quest ${iconName}` })
    );

    const { container } = render(<ScavengerHunt quests={quests} currentGuest={ME} onSelectQuestForCapture={vi.fn()} />);

    // Every quest renders, and each card carries an svg icon.
    for (const iconName of ['heart', 'music', 'smile', 'camera', 'wine', 'users']) {
      expect(screen.getByText(`Quest ${iconName}`)).toBeInTheDocument();
    }
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(6);
  });

  it('marks a quest the viewer has already completed', () => {
    const done = quest({ title: 'Done one', completedByGuestIds: [ME.id] });
    const todo = quest({ title: 'Still open', completedByGuestIds: ['someone-else'] });

    render(<ScavengerHunt quests={[done, todo]} currentGuest={ME} onSelectQuestForCapture={vi.fn()} />);

    expect(screen.getByText('Done one')).toBeInTheDocument();
    expect(screen.getByText('Still open')).toBeInTheDocument();
  });

  it('asks to capture the quest the guest chose', () => {
    // This test asserted nothing for its whole life. It walked from the title
    // to `closest('div').parentElement` and took the first button it found
    // there — which was nothing — then guarded the only assertion behind
    // `if (button)`. Deleting the handler's body left it green. Verified by
    // doing exactly that: replacing `onSelectQuestForCapture(quest.id)` with
    // `undefined` still passed 17/17.
    const onSelect = vi.fn();
    const target = quest({ title: 'Champagne toast' });

    render(<ScavengerHunt quests={[target]} currentGuest={ME} onSelectQuestForCapture={onSelect} />);

    // Found by what the guest actually sees — the file's own convention for
    // labels — so there is no DOM shape to silently stop matching.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('quests.snap_challenge') }));

    expect(onSelect).toHaveBeenCalledWith(target.id);
  });

  it('offers no capture button on a quest already done', () => {
    // The other half of the branch, and the reason the button lookup has to be
    // specific: a query loose enough to match anything would pass here too.
    const onSelect = vi.fn();
    render(
      <ScavengerHunt
        quests={[quest({ title: 'Champagne toast', completedByGuestIds: [ME.id] })]}
        currentGuest={ME}
        onSelectQuestForCapture={onSelect}
      />
    );

    expect(screen.queryByRole('button', { name: i18n.t('quests.snap_challenge') })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("announces the host's grand prize", () => {
    render(
      <ScavengerHunt quests={[quest()]} currentGuest={ME} prize="A weekend in Sozopol" onSelectQuestForCapture={vi.fn()} />
    );

    expect(screen.getByText('A weekend in Sozopol')).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('quests.default_prize'))).toBeNull();
  });

  it.each([null, undefined, ''])('falls back to the localized default prize for %j', (prize) => {
    render(<ScavengerHunt quests={[quest()]} currentGuest={ME} prize={prize} onSelectQuestForCapture={vi.fn()} />);

    expect(screen.getByText(i18n.t('quests.default_prize'))).toBeInTheDocument();
  });

  it('shows the leaderboard with the guest marked, once it has been fetched', () => {
    const leaderboard = [
      { rank: 1, guestId: 'guest-other', name: 'Martin', avatarUrl: null, points: 40, questsCompleted: 2, questIds: [] },
      { rank: 2, guestId: ME.id, name: ME.name, avatarUrl: null, points: 15, questsCompleted: 1, questIds: [] },
    ];

    render(
      <ScavengerHunt quests={[quest()]} currentGuest={ME} leaderboard={leaderboard} onSelectQuestForCapture={vi.fn()} />
    );

    expect(screen.getByRole('heading', { name: i18n.t('leaderboard.title') })).toBeInTheDocument();
    expect(screen.getByText('Martin')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('leaderboard.you'))).toBeInTheDocument();
  });

  describe('each card, against the leaderboard', () => {
    const board = (questIds: string[]) => [
      { rank: 1, guestId: ME.id, name: ME.name, avatarUrl: null, points: 10, questsCompleted: questIds.length, questIds },
    ];

    it('offers a retake on a ticked quest whose photo no longer counts', () => {
      const onSelect = vi.fn();
      const lost = quest({ title: 'Rejected one', completedByGuestIds: [ME.id] });

      render(<ScavengerHunt quests={[lost]} currentGuest={ME} photos={[]} leaderboard={board([])} onSelectQuestForCapture={onSelect} />);

      expect(screen.getByText(i18n.t('quests.not_counted'))).toBeInTheDocument();
      expect(screen.queryByText(i18n.t('quests.done'))).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: i18n.t('quests.snap_again') }));
      expect(onSelect).toHaveBeenCalledWith(lost.id);
    });

    it('says a photo is awaiting the host, and counts it', () => {
      const waiting = quest({ completedByGuestIds: [ME.id] });
      const mine = photo({ id: 'b1a2c3d4-0000-4000-8000-000000000001', guestId: ME.id, questId: waiting.id, status: 'pending' });

      render(
        <ScavengerHunt quests={[waiting, quest()]} currentGuest={ME} photos={[mine]} leaderboard={board([waiting.id])} onSelectQuestForCapture={vi.fn()} />
      );

      expect(screen.getByText(i18n.t('quests.awaiting_approval'))).toBeInTheDocument();
      expect(screen.getByText(/\(1 \/ 2 /)).toBeInTheDocument();
    });

    it('counts only scoring quests in the progress bar', () => {
      const scoredQuest = quest({ completedByGuestIds: [ME.id] });
      const lostQuest = quest({ completedByGuestIds: [ME.id] });

      render(
        <ScavengerHunt
          quests={[scoredQuest, lostQuest]}
          currentGuest={ME}
          photos={[]}
          leaderboard={board([scoredQuest.id])}
          onSelectQuestForCapture={vi.fn()}
        />
      );

      // Both are ticked on this phone; one scores.
      expect(screen.getByText(/\(1 \/ 2 /)).toBeInTheDocument();
      expect(screen.getByText('50%')).toBeInTheDocument();
    });
  });

  describe('the points total', () => {
    const total = () => screen.getByTestId('quest-points-total').textContent;

    it("is the guest's leaderboard score, not the sum of the quests ticked on this phone", () => {
      // Both quests are ticked here, but the host rejected one of the photos:
      // the board, which decides the prize, counts only the other.
      const quests = [quest({ points: 15, completedByGuestIds: [ME.id] }), quest({ points: 25, completedByGuestIds: [ME.id] })];
      const leaderboard = [{ rank: 1, guestId: ME.id, name: ME.name, avatarUrl: null, points: 15, questsCompleted: 1, questIds: [] }];

      render(<ScavengerHunt quests={quests} currentGuest={ME} leaderboard={leaderboard} onSelectQuestForCapture={vi.fn()} />);

      expect(total()).toBe(`15 ${i18n.t('quests.pts')}`);
    });

    it('is zero for a guest the board does not list', () => {
      const leaderboard = [{ rank: 1, guestId: 'guest-other', name: 'Martin', avatarUrl: null, points: 40, questsCompleted: 2, questIds: [] }];

      render(
        <ScavengerHunt
          quests={[quest({ completedByGuestIds: [ME.id] })]}
          currentGuest={ME}
          leaderboard={leaderboard}
          onSelectQuestForCapture={vi.fn()}
        />
      );

      expect(total()).toBe(`0 ${i18n.t('quests.pts')}`);
    });

    it('shows a placeholder, not zero, while the board loads', () => {
      render(<ScavengerHunt quests={[quest()]} currentGuest={ME} leaderboard={null} onSelectQuestForCapture={vi.fn()} />);

      expect(total()).toBe(`… ${i18n.t('quests.pts')}`);
    });
  });

  it('shows no leaderboard when none was provided', () => {
    render(<ScavengerHunt quests={[quest()]} currentGuest={ME} onSelectQuestForCapture={vi.fn()} />);

    expect(screen.queryByRole('heading', { name: i18n.t('leaderboard.title') })).toBeNull();
  });
});

describe('PhotoCard emoji reactions', () => {
  function renderCard(overrides: Partial<Photo> = {}, onReact = vi.fn()) {
    const p = photo(overrides);
    render(
      <PhotoCard
        photo={p}
        currentGuest={ME}
        onLike={vi.fn()}
        onReact={onReact}
        onOpenComments={vi.fn()}
        onOpenLightbox={vi.fn()}
      />
    );
    return { photo: p, onReact };
  }

  it('reacting with a fresh emoji calls onReact with the photo id and that kind', () => {
    // M3 — PhotoCard passes its own id rather than being handed a pre-bound
    // closure, so the parent can give every card the same stable callback and
    // React.memo can actually skip the cards whose photo did not change.
    const { photo, onReact } = renderCard();

    fireEvent.click(screen.getByTitle(i18n.t('reaction.heart')));
    expect(onReact).toHaveBeenCalledWith(photo.id, 'heart');
  });

  it('shows an existing reaction as a counted pill, highlighted for the guest who used it', () => {
    renderCard({
      reactions: [
        { reaction: 'clap', guestId: ME.id },
        { reaction: 'clap', guestId: 'someone-else' },
      ],
    });

    const pill = screen.getByTitle(i18n.t('reaction.clap'));
    expect(pill.textContent).toContain('2');
    // A reaction nobody used yet (heart) stays a bare, unhighlighted glyph button.
    const unused = screen.getByTitle(i18n.t('reaction.heart'));
    expect(unused.textContent).not.toMatch(/\d/);
  });

  it('does not open the lightbox when tapping a reaction', () => {
    const onOpenLightbox = vi.fn();
    const p = photo();
    render(
      <PhotoCard
        photo={p}
        currentGuest={ME}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onOpenComments={vi.fn()}
        onOpenLightbox={onOpenLightbox}
      />
    );

    fireEvent.click(screen.getByTitle(i18n.t('reaction.party')));
    expect(onOpenLightbox).not.toHaveBeenCalled();
  });
});

describe('PhotoCard comment preview', () => {
  function comment(overrides: Partial<PhotoComment> = {}): PhotoComment {
    return {
      id: `c-${Math.random().toString(36).slice(2, 8)}`,
      photoId: 'p1',
      guestId: 'someone',
      guestName: 'Elena',
      commentText: 'Beautiful moment!',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('shows nothing when there are no comments', () => {
    const p = photo({ comments: [], commentsCount: 0 });
    render(
      <PhotoCard
        photo={p}
        currentGuest={ME}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onOpenComments={vi.fn()}
        onOpenLightbox={vi.fn()}
      />
    );
    expect(screen.queryByText('Beautiful moment!')).not.toBeInTheDocument();
  });

  it('shows the latest comment inline without a "view all" link for exactly one comment', () => {
    const p = photo({
      comments: [comment({ guestName: 'Elena', commentText: 'So happy for you!' })],
      commentsCount: 1,
    });
    render(
      <PhotoCard
        photo={p}
        currentGuest={ME}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onOpenComments={vi.fn()}
        onOpenLightbox={vi.fn()}
      />
    );
    expect(screen.getByText('Elena')).toBeInTheDocument();
    expect(screen.getByText(/So happy for you!/)).toBeInTheDocument();
    expect(screen.queryByText(/view all/i)).not.toBeInTheDocument();
  });

  it('shows a "view all N comments" link and the latest comment when there is more than one', () => {
    const p = photo({
      comments: [
        comment({ guestName: 'Elena', commentText: 'First!' }),
        comment({ guestName: 'Martin', commentText: 'Latest one here' }),
      ],
      commentsCount: 2,
    });
    render(
      <PhotoCard
        photo={p}
        currentGuest={ME}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onOpenComments={vi.fn()}
        onOpenLightbox={vi.fn()}
      />
    );
    expect(screen.getByText(i18n.t('feed.view_all_comments', { n: 2 }))).toBeInTheDocument();
    // Only the most recent comment is previewed, not the earlier one.
    expect(screen.getByText(/Latest one here/)).toBeInTheDocument();
    expect(screen.queryByText(/^First!$/)).not.toBeInTheDocument();
  });

  it('opens the comments view when the preview is clicked', () => {
    const onOpenComments = vi.fn();
    const p = photo({ comments: [comment()], commentsCount: 1 });
    render(
      <PhotoCard
        photo={p}
        currentGuest={ME}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onOpenComments={onOpenComments}
        onOpenLightbox={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText(/Beautiful moment!/));
    expect(onOpenComments).toHaveBeenCalledWith(p);
  });
});
