import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQuestLeaderboard, leaderboardTrigger } from '../../src/hooks/useQuestLeaderboard';
import { questsApi } from '../../src/api/questsApi';
import { Photo, QuestLeaderboardEntry, ScavengerQuest } from '../../src/types';

/**
 * The leaderboard has no socket message of its own; it refetches when the
 * quests or photos this client already holds change. So the things worth
 * pinning are when it asks — at once, soon after a change, never in a storm —
 * and that an old answer can never overwrite a newer one.
 */

function entry(name: string, points: number, rank = 1): QuestLeaderboardEntry {
  return { rank, guestId: `g-${name}`, name, avatarUrl: null, points, questsCompleted: 1, questIds: [] };
}

function quest(completedByGuestIds: string[] = []): ScavengerQuest {
  return {
    id: 'q1',
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
  return { id: 'p1', eventId: 'e1', guestId: 'g1', status: 'approved', questId: 'q1', ...overrides } as Photo;
}

/** Let resolved API promises land inside act. */
const flush = () => act(async () => undefined);

describe('useQuestLeaderboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches at once when enabled', async () => {
    const fetch = vi.spyOn(questsApi, 'leaderboard').mockResolvedValue([entry('Maria', 15)]);

    const { result } = renderHook(() => useQuestLeaderboard('e1', true, [], []));
    await flush();

    expect(fetch).toHaveBeenCalledWith('e1');
    expect(result.current?.map((e) => e.name)).toEqual(['Maria']);
  });

  it('answers null, not an empty board, until the first fetch lands', async () => {
    // Empty would read as "nobody has scored" and show a guest 0 points.
    let answer: (entries: QuestLeaderboardEntry[]) => void = () => undefined;
    vi.spyOn(questsApi, 'leaderboard').mockImplementation(() => new Promise((resolve) => (answer = resolve)));

    // Every value rendered, including the very first frame, before any effect
    // has run: that frame is painted too.
    const rendered: unknown[] = [];
    const { result } = renderHook(() => {
      const value = useQuestLeaderboard('e1', true, [], []);
      rendered.push(value);
      return value;
    });
    await flush();
    expect(rendered[0]).toBeNull();
    expect(result.current).toBeNull();

    answer([]);
    await flush();
    expect(result.current).toEqual([]);
  });

  it('stays null when the first fetch fails, rather than claiming an empty board', async () => {
    vi.spyOn(questsApi, 'leaderboard').mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useQuestLeaderboard('e1', true, [], []));
    await flush();

    expect(result.current).toBeNull();
  });

  it("forgets one event's board when switching to another", async () => {
    vi.spyOn(questsApi, 'leaderboard')
      .mockResolvedValueOnce([entry('Maria', 15)])
      .mockImplementation(() => new Promise(() => undefined));
    const { result, rerender } = renderHook(({ eventId }) => useQuestLeaderboard(eventId, true, [], []), {
      initialProps: { eventId: 'e1' },
    });
    await flush();
    expect(result.current?.map((e) => e.name)).toEqual(['Maria']);

    rerender({ eventId: 'e2' });
    await flush();

    expect(result.current).toBeNull();
  });

  it('does not fetch while disabled — a locked plan or a tab nobody is looking at', async () => {
    const fetch = vi.spyOn(questsApi, 'leaderboard').mockResolvedValue([]);

    renderHook(() => useQuestLeaderboard('e1', false, [quest()], []));
    await flush();
    act(() => vi.advanceTimersByTime(120_000));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('refetches once, shortly after a burst of quest photos, not once per photo', async () => {
    const fetch = vi.spyOn(questsApi, 'leaderboard').mockResolvedValue([]);
    const { rerender } = renderHook(({ photos }) => useQuestLeaderboard('e1', true, [quest()], photos), {
      initialProps: { photos: [] as Photo[] },
    });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    rerender({ photos: [photo({ id: 'a' })] });
    act(() => vi.advanceTimersByTime(500));
    rerender({ photos: [photo({ id: 'a' }), photo({ id: 'b' })] });
    act(() => vi.advanceTimersByTime(500));
    rerender({ photos: [photo({ id: 'a' }), photo({ id: 'b' }), photo({ id: 'c' })] });
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1500));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores a re-render that changes nothing a score depends on', async () => {
    const fetch = vi.spyOn(questsApi, 'leaderboard').mockResolvedValue([]);
    const { rerender } = renderHook(({ photos }) => useQuestLeaderboard('e1', true, [quest()], photos), {
      initialProps: { photos: [photo()] },
    });
    await flush();

    // A new array holding the same photo — what every unrelated state update produces.
    rerender({ photos: [photo()] });
    act(() => vi.advanceTimersByTime(5000));

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('still catches up on a slow timer, for changes this client is never sent', async () => {
    const fetch = vi.spyOn(questsApi, 'leaderboard').mockResolvedValue([]);

    renderHook(() => useQuestLeaderboard('e1', true, [], []));
    await flush();
    act(() => vi.advanceTimersByTime(60_000));

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never lets a slow, older answer overwrite a newer one', async () => {
    let answerFirst: (entries: QuestLeaderboardEntry[]) => void = () => undefined;
    vi.spyOn(questsApi, 'leaderboard')
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValue([entry('Newer', 30)]);
    const { result, rerender } = renderHook(({ quests }) => useQuestLeaderboard('e1', true, quests, []), {
      initialProps: { quests: [quest()] },
    });

    rerender({ quests: [quest(['g1'])] });
    act(() => vi.advanceTimersByTime(1500));
    await flush();
    expect(result.current?.map((e) => e.name)).toEqual(['Newer']);

    answerFirst([entry('Older', 10)]);
    await flush();

    expect(result.current?.map((e) => e.name)).toEqual(['Newer']);
  });

  it('keeps the last board on screen when a refresh fails', async () => {
    vi.spyOn(questsApi, 'leaderboard')
      .mockResolvedValueOnce([entry('Maria', 15)])
      .mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useQuestLeaderboard('e1', true, [], []));
    await flush();

    act(() => vi.advanceTimersByTime(60_000));
    await flush();

    expect(result.current?.map((e) => e.name)).toEqual(['Maria']);
  });

  it('stops asking once unmounted', async () => {
    const fetch = vi.spyOn(questsApi, 'leaderboard').mockResolvedValue([]);
    const { unmount } = renderHook(() => useQuestLeaderboard('e1', true, [], []));
    await flush();

    unmount();
    act(() => vi.advanceTimersByTime(180_000));

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('leaderboardTrigger', () => {
  const base = leaderboardTrigger([quest()], [photo()]);

  it('moves when a quest is claimed', () => {
    expect(leaderboardTrigger([quest(['g1'])], [photo()])).not.toBe(base);
  });

  it('moves when a quest photo is rejected or deleted', () => {
    expect(leaderboardTrigger([quest()], [photo({ status: 'rejected' })])).not.toBe(base);
    expect(leaderboardTrigger([quest()], [])).not.toBe(base);
  });

  it('ignores photos that belong to no quest', () => {
    expect(leaderboardTrigger([quest()], [photo(), photo({ id: 'p2', questId: undefined })])).toBe(base);
  });
});
