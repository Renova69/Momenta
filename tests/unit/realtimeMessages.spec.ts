import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyRealtimeMessage } from '../../src/services/realtimeMessages';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { ServiceContext } from '../../src/services/storageServiceContext';
import { Photo, PhotoComment, ScavengerQuest, AudioGuestbookEntry, WeddingEvent } from '../../src/types';

/**
 * The live WebSocket feed.
 *
 * Every guest's screen is driven by these handlers, and they are the only place
 * that reconciles an optimistic local write against the server's authoritative
 * copy. Getting that wrong shows a duplicate photo, a like that bounces back,
 * or a comment that disappears on the next render — visible to everyone in the
 * room at once, and impossible to reproduce afterwards.
 *
 * `eventBroadcastNormalization.spec.ts` already covers EVENT_UPDATED in depth.
 * This covers the rest of the dispatcher.
 */

const EVENT_ID = 'aaaaaaaa-1111-4222-8333-444455556666';

interface Harness {
  ctx: ServiceContext;
  photos: Photo[];
  quests: ScavengerQuest[];
  audio: AudioGuestbookEntry[];
  notify: ReturnType<typeof vi.fn>;
  emitReaction: ReturnType<typeof vi.fn>;
}

function harness(seed: {
  photos?: Partial<Photo>[];
  quests?: Partial<ScavengerQuest>[];
  audio?: Partial<AudioGuestbookEntry>[];
} = {}): Harness {
  const photos = (seed.photos ?? []) as Photo[];
  const quests = (seed.quests ?? []) as ScavengerQuest[];
  const audio = (seed.audio ?? []) as AudioGuestbookEntry[];
  const notify = vi.fn();
  const emitReaction = vi.fn();

  const ctx = {
    getEvent: () => ({ id: EVENT_ID }) as WeddingEvent,
    getPhotos: () => photos,
    getQuests: () => quests,
    getAudioEntries: () => audio,
    getCurrentGuest: () => null,
    updateEvent: vi.fn(),
    notify,
    notifyError: vi.fn(),
    syncGuestFromServer: vi.fn(),
    completeQuest: vi.fn(),
    joinEventRoom: vi.fn(),
    syncFromBackend: vi.fn().mockResolvedValue(undefined),
    emitReaction,
  } as unknown as ServiceContext;

  return { ctx, photos, quests, audio, notify, emitReaction };
}

/** What ended up in storage for this event's photos. */
function storedPhotos(): Photo[] {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT_ID)) || '[]');
}
function storedQuests(): ScavengerQuest[] {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTS(EVENT_ID)) || '[]');
}
function storedAudio(): AudioGuestbookEntry[] {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.AUDIO(EVENT_ID)) || '[]');
}

const photo = (over: Partial<Photo> = {}): Partial<Photo> => ({
  id: 'p1',
  eventId: EVENT_ID,
  likedByGuestIds: [],
  likesCount: 0,
  reactions: [],
  comments: [],
  commentsCount: 0,
  ...over,
});

/** A PhotoComment with the fields the type requires, overridable per test. */
const fixtureComment = (over: Partial<PhotoComment> = {}): PhotoComment => ({
  id: 'c1',
  photoId: 'p1',
  guestId: 'g9',
  guestName: 'Ana',
  commentText: 'Beautiful',
  createdAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => localStorage.clear());

describe('event-room isolation', () => {
  it('ignores a message addressed to a different wedding', () => {
    const h = harness({ photos: [photo()] });

    applyRealtimeMessage(h.ctx, {
      type: 'PHOTO_REMOVED',
      eventId: 'ffffffff-9999-4222-8333-444455556666',
      payload: { photoId: 'p1' },
    });

    // Nothing written, nothing re-rendered: another couple's album must not
    // be able to mutate this one's screen.
    expect(h.notify).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT_ID))).toBeNull();
  });

  it('accepts a message with no eventId, which is the room-scoped case', () => {
    const h = harness({ photos: [photo()] });
    applyRealtimeMessage(h.ctx, { type: 'PHOTO_REMOVED', payload: { photoId: 'p1' } });
    expect(storedPhotos()).toHaveLength(0);
  });
});

describe('PHOTO_ADDED', () => {
  it('prepends a new photo so the newest is first', () => {
    const h = harness({ photos: [photo({ id: 'old' })] });

    applyRealtimeMessage(h.ctx, { type: 'PHOTO_ADDED', payload: photo({ id: 'new' }) });

    expect(storedPhotos().map((p) => p.id)).toEqual(['new', 'old']);
    expect(h.notify).toHaveBeenCalled();
  });

  it('replaces the uploader\'s optimistic copy instead of showing it twice', () => {
    // The uploader already rendered this photo locally under a temporary id.
    // Without the localId match they would see their own photo twice.
    const h = harness({ photos: [photo({ id: 'local-tmp', caption: 'optimistic' })] });

    applyRealtimeMessage(h.ctx, {
      type: 'PHOTO_ADDED',
      payload: { ...photo({ id: 'server-id', caption: 'real' }), localId: 'local-tmp' },
    });

    const stored = storedPhotos();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('server-id');
    expect(stored[0].caption).toBe('real');
  });

  it('ignores a re-delivery of a photo already present', () => {
    const h = harness({ photos: [photo({ id: 'p1' })] });

    applyRealtimeMessage(h.ctx, { type: 'PHOTO_ADDED', payload: photo({ id: 'p1' }) });

    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('likes', () => {
  it('records a like and keeps the count in step', () => {
    const h = harness({ photos: [photo()] });

    applyRealtimeMessage(h.ctx, { type: 'PHOTO_LIKED', payload: { photoId: 'p1', guestId: 'g1' } });

    expect(storedPhotos()[0].likedByGuestIds).toEqual(['g1']);
    expect(storedPhotos()[0].likesCount).toBe(1);
  });

  it('is idempotent, so a duplicate broadcast cannot inflate the count', () => {
    const h = harness({ photos: [photo({ likedByGuestIds: ['g1'], likesCount: 1 })] });

    applyRealtimeMessage(h.ctx, { type: 'PHOTO_LIKED', payload: { photoId: 'p1', guestId: 'g1' } });

    expect(storedPhotos()[0].likedByGuestIds).toEqual(['g1']);
    expect(storedPhotos()[0].likesCount).toBe(1);
  });

  it('removes a like', () => {
    const h = harness({ photos: [photo({ likedByGuestIds: ['g1', 'g2'], likesCount: 2 })] });

    applyRealtimeMessage(h.ctx, { type: 'PHOTO_UNLIKED', payload: { photoId: 'p1', guestId: 'g1' } });

    expect(storedPhotos()[0].likedByGuestIds).toEqual(['g2']);
  });

  it('leaves other photos untouched', () => {
    const h = harness({ photos: [photo({ id: 'p1' }), photo({ id: 'p2' })] });

    applyRealtimeMessage(h.ctx, { type: 'PHOTO_LIKED', payload: { photoId: 'p1', guestId: 'g1' } });

    expect(storedPhotos()[1].likedByGuestIds).toEqual([]);
  });
});

describe('emoji reactions on a photo', () => {
  it('adds a reaction', () => {
    const h = harness({ photos: [photo()] });

    applyRealtimeMessage(h.ctx, {
      type: 'PHOTO_REACTION_ADDED',
      payload: { photoId: 'p1', guestId: 'g1', reaction: 'heart' },
    });

    expect(storedPhotos()[0].reactions).toEqual([{ reaction: 'heart', guestId: 'g1' }]);
  });

  it('does not duplicate the same guest\'s same reaction', () => {
    const h = harness({ photos: [photo({ reactions: [{ reaction: 'heart', guestId: 'g1' }] })] });

    applyRealtimeMessage(h.ctx, {
      type: 'PHOTO_REACTION_ADDED',
      payload: { photoId: 'p1', guestId: 'g1', reaction: 'heart' },
    });

    expect(storedPhotos()[0].reactions).toHaveLength(1);
  });

  it('allows the same guest a different reaction', () => {
    const h = harness({ photos: [photo({ reactions: [{ reaction: 'heart', guestId: 'g1' }] })] });

    applyRealtimeMessage(h.ctx, {
      type: 'PHOTO_REACTION_ADDED',
      payload: { photoId: 'p1', guestId: 'g1', reaction: 'clap' },
    });

    expect(storedPhotos()[0].reactions).toHaveLength(2);
  });

  it('removes only the matching guest-and-reaction pair', () => {
    const h = harness({
      photos: [
        photo({
          reactions: [
            { reaction: 'heart', guestId: 'g1' },
            { reaction: 'clap', guestId: 'g1' },
            { reaction: 'heart', guestId: 'g2' },
          ],
        }),
      ],
    });

    applyRealtimeMessage(h.ctx, {
      type: 'PHOTO_REACTION_REMOVED',
      payload: { photoId: 'p1', guestId: 'g1', reaction: 'heart' },
    });

    expect(storedPhotos()[0].reactions).toEqual([
      { reaction: 'clap', guestId: 'g1' },
      { reaction: 'heart', guestId: 'g2' },
    ]);
  });
});

describe('COMMENT_ADDED', () => {
  it('appends a comment and keeps the count in step', () => {
    const h = harness({ photos: [photo()] });

    applyRealtimeMessage(h.ctx, {
      type: 'COMMENT_ADDED',
      payload: { id: 'c1', photoId: 'p1', commentText: 'Beautiful' },
    });

    expect(storedPhotos()[0].comments).toHaveLength(1);
    expect(storedPhotos()[0].commentsCount).toBe(1);
  });

  it('replaces the author\'s optimistic copy rather than duplicating it', () => {
    const h = harness({
      photos: [photo({ comments: [fixtureComment({ id: 'local-1', commentText: 'sending…' })], commentsCount: 1 })],
    });

    applyRealtimeMessage(h.ctx, {
      type: 'COMMENT_ADDED',
      payload: { id: 'c1', localId: 'local-1', photoId: 'p1', commentText: 'Beautiful' },
    });

    const comments = storedPhotos()[0].comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe('c1');
    expect(storedPhotos()[0].commentsCount).toBe(1);
  });

  it('ignores a re-delivered comment', () => {
    const h = harness({
      photos: [photo({ comments: [fixtureComment({ id: 'c1' })], commentsCount: 1 })],
    });

    applyRealtimeMessage(h.ctx, {
      type: 'COMMENT_ADDED',
      payload: { id: 'c1', photoId: 'p1', commentText: 'Beautiful' },
    });

    expect(storedPhotos()[0].comments).toHaveLength(1);
  });
});

describe('moderation', () => {
  it('applies a status change', () => {
    const h = harness({ photos: [photo({ status: 'pending' })] });

    applyRealtimeMessage(h.ctx, {
      type: 'PHOTO_STATUS_UPDATED',
      payload: { photoId: 'p1', status: 'approved' },
    });

    expect(storedPhotos()[0].status).toBe('approved');
  });

  it('drops a removed photo', () => {
    const h = harness({ photos: [photo({ id: 'p1' }), photo({ id: 'p2' })] });

    applyRealtimeMessage(h.ctx, { type: 'PHOTO_REMOVED', payload: { photoId: 'p1' } });

    expect(storedPhotos().map((p) => p.id)).toEqual(['p2']);
  });
});

describe('quests', () => {
  const quest = (over: Partial<ScavengerQuest> = {}): Partial<ScavengerQuest> => ({
    id: 'q1',
    title: 'Find the cake',
    completedByGuestIds: [],
    ...over,
  });

  it('adds a new quest', () => {
    const h = harness({ quests: [] });
    applyRealtimeMessage(h.ctx, { type: 'QUEST_ADDED', payload: quest() });
    expect(storedQuests()).toHaveLength(1);
  });

  it('replaces the host\'s optimistic copy', () => {
    const h = harness({ quests: [quest({ id: 'local-q', title: 'draft' })] });

    applyRealtimeMessage(h.ctx, {
      type: 'QUEST_ADDED',
      payload: { ...quest({ id: 'q1', title: 'Find the cake' }), localId: 'local-q' },
    });

    expect(storedQuests()).toHaveLength(1);
    expect(storedQuests()[0].id).toBe('q1');
  });

  it('ignores a re-delivered quest', () => {
    const h = harness({ quests: [quest({ id: 'q1' })] });
    applyRealtimeMessage(h.ctx, { type: 'QUEST_ADDED', payload: quest({ id: 'q1' }) });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('deletes a quest', () => {
    const h = harness({ quests: [quest({ id: 'q1' }), quest({ id: 'q2' })] });
    applyRealtimeMessage(h.ctx, { type: 'QUEST_DELETED', payload: { questId: 'q1' } });
    expect(storedQuests().map((q) => q.id)).toEqual(['q2']);
  });

  it('records a completion once per guest', () => {
    const h = harness({ quests: [quest({ completedByGuestIds: ['g1'] })] });

    applyRealtimeMessage(h.ctx, { type: 'QUEST_COMPLETED', payload: { questId: 'q1', guestId: 'g1' } });
    expect(storedQuests()[0].completedByGuestIds).toEqual(['g1']);

    applyRealtimeMessage(h.ctx, { type: 'QUEST_COMPLETED', payload: { questId: 'q1', guestId: 'g2' } });
    expect(storedQuests()[0].completedByGuestIds).toEqual(['g1', 'g2']);
  });
});

describe('AUDIO_ADDED', () => {
  const entry = (over: Partial<AudioGuestbookEntry> = {}): Partial<AudioGuestbookEntry> => ({
    id: 'a1',
    eventId: EVENT_ID,
    ...over,
  });

  it('prepends a new message', () => {
    const h = harness({ audio: [entry({ id: 'old' })] });
    applyRealtimeMessage(h.ctx, { type: 'AUDIO_ADDED', payload: entry({ id: 'new' }) });
    expect(storedAudio().map((a) => a.id)).toEqual(['new', 'old']);
  });

  it('replaces the recorder\'s optimistic copy', () => {
    const h = harness({ audio: [entry({ id: 'local-a' })] });

    applyRealtimeMessage(h.ctx, {
      type: 'AUDIO_ADDED',
      payload: { ...entry({ id: 'a1' }), localId: 'local-a' },
    });

    expect(storedAudio()).toHaveLength(1);
    expect(storedAudio()[0].id).toBe('a1');
  });

  it('ignores a re-delivered message', () => {
    const h = harness({ audio: [entry({ id: 'a1' })] });
    applyRealtimeMessage(h.ctx, { type: 'AUDIO_ADDED', payload: entry({ id: 'a1' }) });
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('ephemeral reactions', () => {
  it('emits a single reaction without persisting anything', () => {
    const h = harness();

    applyRealtimeMessage(h.ctx, {
      type: 'REACTION_SENT',
      payload: { reaction: 'heart', guestName: 'Ana' },
    });

    expect(h.emitReaction).toHaveBeenCalledWith('heart', 'Ana');
    expect(localStorage.length).toBe(0);
  });

  it('passes a null name through rather than undefined', () => {
    const h = harness();
    applyRealtimeMessage(h.ctx, { type: 'REACTION_SENT', payload: { reaction: 'clap' } });
    expect(h.emitReaction).toHaveBeenCalledWith('clap', null);
  });

  it('ignores a malformed payload with no reaction', () => {
    const h = harness();
    applyRealtimeMessage(h.ctx, { type: 'REACTION_SENT', payload: {} });
    applyRealtimeMessage(h.ctx, { type: 'REACTION_SENT', payload: null });
    expect(h.emitReaction).not.toHaveBeenCalled();
  });

  it('fans a coalesced batch out into individual emissions (P6)', () => {
    // The server batches reactions during a burst. The projector wall's
    // animation logic must not have to know the difference.
    const h = harness();

    applyRealtimeMessage(h.ctx, {
      type: 'REACTIONS_BATCH',
      payload: {
        reactions: [
          { reaction: 'heart', guestName: 'Ana' },
          { reaction: 'clap' },
          { notAReaction: true },
        ],
      },
    });

    expect(h.emitReaction).toHaveBeenCalledTimes(2);
    expect(h.emitReaction).toHaveBeenNthCalledWith(1, 'heart', 'Ana');
    expect(h.emitReaction).toHaveBeenNthCalledWith(2, 'clap', null);
  });

  it('tolerates a batch with no reactions array', () => {
    const h = harness();
    applyRealtimeMessage(h.ctx, { type: 'REACTIONS_BATCH', payload: {} });
    expect(h.emitReaction).not.toHaveBeenCalled();
  });
});

describe('unknown message types', () => {
  it('is ignored rather than throwing', () => {
    const h = harness({ photos: [photo()] });
    expect(() =>
      applyRealtimeMessage(h.ctx, { type: 'SOMETHING_THE_SERVER_ADDED_LATER', payload: {} })
    ).not.toThrow();
    expect(h.notify).not.toHaveBeenCalled();
  });
});
