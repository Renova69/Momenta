import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addQuest, deleteQuest, getQuests } from '../../src/services/questService';
import { questsApi } from '../../src/api/questsApi';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { ServiceContext } from '../../src/services/storageServiceContext';
import { ScavengerQuest, WeddingEvent } from '../../src/types';

/**
 * The host's own quest list.
 *
 * Every action here writes locally first and syncs afterwards, because a
 * wedding runs on venue Wi-Fi. That optimism is the risk: a refusal has to
 * put the list back the way the server still has it, and say so, rather than
 * leaving the host looking at something that is not true.
 */

const EVENT_ID = 'dddddddd-4444-4555-8666-777788889999';
const SERVER_QUEST_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

function harness(seed: Partial<ScavengerQuest>[] = []) {
  localStorage.setItem(STORAGE_KEYS.QUESTS(EVENT_ID), JSON.stringify(seed));
  const notify = vi.fn();
  const notifyError = vi.fn();
  const ctx = {
    getEvent: () => ({ id: EVENT_ID }) as WeddingEvent,
    getQuests: (id?: string) => JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTS(id || EVENT_ID)) || '[]'),
    getPhotos: () => [],
    getAudioEntries: () => [],
    getCurrentGuest: () => null,
    updateEvent: vi.fn(),
    notify,
    notifyError,
    notifyEventGone: vi.fn(),
    syncGuestFromServer: vi.fn(),
    forgetGuestIdentity: vi.fn(),
    completeQuest: vi.fn(),
    joinEventRoom: vi.fn(),
    syncFromBackend: vi.fn().mockResolvedValue(undefined),
    emitReaction: vi.fn(),
  } as unknown as ServiceContext;
  return { ctx, notify, notifyError };
}

const quest = (over: Partial<ScavengerQuest> = {}): Partial<ScavengerQuest> => ({
  id: SERVER_QUEST_ID,
  eventId: EVENT_ID,
  title: 'First dance',
  description: '',
  iconName: 'heart',
  points: 10,
  isActive: true,
  completedByGuestIds: [],
  ...over,
});

const stored = (): ScavengerQuest[] => JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTS(EVENT_ID)) || '[]');

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('deleteQuest', () => {
  it('removes it at once and tells the server', async () => {
    const { ctx, notify } = harness([quest(), quest({ id: 'b2c3d4e5-0000-4000-8000-000000000002', title: 'Cake' })]);
    const api = vi.spyOn(questsApi, 'delete').mockResolvedValue({ success: true, questId: SERVER_QUEST_ID });

    deleteQuest(ctx, SERVER_QUEST_ID);

    expect(stored().map((q) => q.title)).toEqual(['Cake']);
    expect(api).toHaveBeenCalledWith(SERVER_QUEST_ID);
    expect(notify).toHaveBeenCalled();
  });

  it('puts it back and says so when the server refuses', async () => {
    // Otherwise the host is looking at a quest list the server does not have,
    // and the quest returns at the next sync with no explanation.
    const { ctx, notifyError } = harness([quest()]);
    vi.spyOn(questsApi, 'delete').mockRejectedValue(new Error('Forbidden'));

    deleteQuest(ctx, SERVER_QUEST_ID);
    expect(stored()).toHaveLength(0);

    await vi.waitFor(() => expect(stored()).toHaveLength(1));
    expect(notifyError).toHaveBeenCalledWith('Forbidden');
  });

  it('never asks the server about a quest it has never seen', async () => {
    // addQuest writes a local id first and swaps in the server's afterwards.
    // Deleting one still in flight must not send that placeholder.
    const { ctx } = harness();
    vi.spyOn(questsApi, 'create').mockImplementation(() => new Promise(() => undefined));
    const api = vi.spyOn(questsApi, 'delete');

    const created = addQuest(ctx, 'Typo', 'oops');
    deleteQuest(ctx, created.id);

    expect(created.id.startsWith('quest-')).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(getQuests(ctx, EVENT_ID)).toHaveLength(0);
  });

  it('leaves the other quests alone', () => {
    const { ctx } = harness([
      quest({ id: SERVER_QUEST_ID, title: 'Going' }),
      quest({ id: 'c3d4e5f6-0000-4000-8000-000000000003', title: 'Staying' }),
    ]);
    vi.spyOn(questsApi, 'delete').mockResolvedValue({ success: true, questId: SERVER_QUEST_ID });

    deleteQuest(ctx, SERVER_QUEST_ID);

    expect(stored().map((q) => q.title)).toEqual(['Staying']);
  });
});
