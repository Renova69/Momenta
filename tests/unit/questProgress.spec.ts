import { describe, it, expect } from 'vitest';
import { questCardState, scoredQuestIds, isScoringState } from '../../src/components/quests/questProgress';
import { Photo, QuestLeaderboardEntry, ScavengerQuest } from '../../src/types';

/**
 * What a guest's quest card says about that quest.
 *
 * It has to agree with the leaderboard, which decides the prize, while also
 * reacting the moment a photo is taken rather than a refetch later. Each case
 * below is one situation a guest can actually be in at the reception.
 */

const ME = 'guest-me';
const QUEST = 'quest-1';

function quest(completedByGuestIds: string[] = []): ScavengerQuest {
  return {
    id: QUEST,
    eventId: 'e1',
    title: 'First dance',
    description: '',
    iconName: 'heart',
    points: 10,
    isActive: true,
    completedByGuestIds,
  };
}

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    eventId: 'e1',
    guestId: ME,
    questId: QUEST,
    status: 'approved',
    ...overrides,
  } as Photo;
}

const LOCAL_ID = 'photo-1789812184976-ab12c';
const loadedNothingScored = new Set<string>();
const loadedScored = new Set([QUEST]);

describe('questCardState', () => {
  it('is open before the guest has tried it', () => {
    expect(questCardState(quest(), ME, [], loadedNothingScored)).toBe('open');
  });

  it('is completed by the guest’s own confirmed photo, without waiting for the server', () => {
    // The board refetches about 1.5s after an upload lands; the card should not.
    expect(questCardState(quest([ME]), ME, [photo()], loadedNothingScored)).toBe('completed');
    expect(questCardState(quest([ME]), ME, [photo({ status: 'featured' })], loadedNothingScored)).toBe('completed');
  });

  it('is awaiting approval while the host has not decided, even if the server already counts it', () => {
    expect(questCardState(quest([ME]), ME, [photo({ status: 'pending' })], loadedScored)).toBe('awaiting');
  });

  it('prefers an approved photo to a pending retake', () => {
    const photos = [photo({ status: 'pending', id: 'b1' }), photo({ status: 'approved', id: 'b2' })];
    expect(questCardState(quest([ME]), ME, photos, loadedScored)).toBe('completed');
  });

  it('is uploading while the only photo is still on the phone', () => {
    expect(questCardState(quest([ME]), ME, [photo({ id: LOCAL_ID })], loadedNothingScored)).toBe('uploading');
    // A moderated event gives the local copy 'pending'; it is still just uploading.
    expect(questCardState(quest([ME]), ME, [photo({ id: LOCAL_ID, status: 'pending' })], null)).toBe('uploading');
  });

  it('is completed on the server’s word when the photo is too old to be loaded on the phone', () => {
    // The feed is paginated: an early quest photo may simply not be here.
    expect(questCardState(quest([ME]), ME, [], loadedScored)).toBe('completed');
  });

  it('is not counted when a tick has no photo behind it', () => {
    expect(questCardState(quest([ME]), ME, [], loadedNothingScored)).toBe('not_counted');
  });

  it('says rejected when the host rejected the photo, so the guest knows why', () => {
    expect(questCardState(quest([ME]), ME, [photo({ status: 'rejected' })], loadedNothingScored)).toBe('rejected');
  });

  it('says rejected even before the board loads, because the phone already knows', () => {
    expect(questCardState(quest([ME]), ME, [photo({ status: 'rejected' })], null)).toBe('rejected');
  });

  it("does not call a quest rejected for someone else's rejected photo", () => {
    expect(questCardState(quest([ME]), ME, [photo({ guestId: 'guest-other', status: 'rejected' })], loadedNothingScored)).toBe(
      'not_counted'
    );
  });

  it('prefers a counting retake to an older rejection', () => {
    const photos = [photo({ id: 'r1', status: 'rejected' }), photo({ id: 'r2', status: 'approved' })];
    expect(questCardState(quest([ME]), ME, photos, loadedNothingScored)).toBe('completed');
  });

  it('shows a retake in flight after a rejection as uploading', () => {
    const photos = [photo({ status: 'rejected' }), photo({ id: LOCAL_ID })];
    expect(questCardState(quest([ME]), ME, photos, loadedNothingScored)).toBe('uploading');
  });

  it("does not count someone else's photo, or the guest's photo for another quest", () => {
    const photos = [photo({ guestId: 'guest-other' }), photo({ questId: 'quest-2' })];
    expect(questCardState(quest([ME]), ME, photos, loadedNothingScored)).toBe('not_counted');
  });

  it('keeps a tick as completed while the board is still loading, rather than alarming the guest', () => {
    expect(questCardState(quest([ME]), ME, [], null)).toBe('completed');
  });
});

describe('scoredQuestIds', () => {
  const board: QuestLeaderboardEntry[] = [
    { rank: 1, guestId: ME, name: 'Me', avatarUrl: null, points: 10, questsCompleted: 1, questIds: [QUEST] },
  ];

  it('is null until the board has loaded', () => {
    expect(scoredQuestIds(null, ME)).toBeNull();
    expect(scoredQuestIds(undefined, ME)).toBeNull();
  });

  it("is the guest's scored quests once it has", () => {
    expect([...(scoredQuestIds(board, ME) ?? [])]).toEqual([QUEST]);
  });

  it('is empty, not null, for a guest the board does not list', () => {
    expect(scoredQuestIds(board, 'guest-other')?.size).toBe(0);
  });
});

describe('isScoringState', () => {
  it('counts completed and awaiting, and nothing else', () => {
    expect(['completed', 'awaiting', 'uploading', 'rejected', 'not_counted', 'open'].filter((s) => isScoringState(s as never))).toEqual([
      'completed',
      'awaiting',
    ]);
  });
});
