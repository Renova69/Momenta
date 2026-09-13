import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getPhotos,
  toggleLikePhoto,
  togglePhotoReaction,
  addComment,
  setPhotoStatus,
  deletePhoto,
  reconcileFlushedPhoto,
} from '../../src/services/photoService';
import { photosApi } from '../../src/api/photosApi';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { ServiceContext } from '../../src/services/storageServiceContext';
import { Photo, WeddingEvent } from '../../src/types';

/**
 * A guest interacting with a photo.
 *
 * Every one of these writes locally first and syncs afterwards, because a
 * wedding runs on venue Wi-Fi and a tap that waits for a round trip feels
 * broken. That optimism is the risk: the local write must be correct on its
 * own, the sync failure must not corrupt it, and a rejected guest identity
 * must be forgotten rather than retried forever with a credential the server
 * has stopped honouring.
 */

const EVENT_ID = 'cccccccc-3333-4444-8555-666677778888';

function harness(seed: Partial<Photo>[] = []) {
  localStorage.setItem(STORAGE_KEYS.PHOTOS(EVENT_ID), JSON.stringify(seed));
  const notify = vi.fn();
  const forgetGuestIdentity = vi.fn();
  const syncGuestFromServer = vi.fn();
  const ctx = {
    getEvent: () => ({ id: EVENT_ID }) as WeddingEvent,
    getPhotos: (id?: string) =>
      JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(id || EVENT_ID)) || '[]'),
    getQuests: () => [],
    getAudioEntries: () => [],
    getCurrentGuest: () => ({ id: 'g1', guestToken: 'tok-1' }),
    updateEvent: vi.fn(),
    notify,
    notifyError: vi.fn(),
    syncGuestFromServer,
    forgetGuestIdentity,
    completeQuest: vi.fn(),
    joinEventRoom: vi.fn(),
    syncFromBackend: vi.fn().mockResolvedValue(undefined),
    emitReaction: vi.fn(),
  } as unknown as ServiceContext;
  return { ctx, notify, forgetGuestIdentity, syncGuestFromServer };
}

const stored = (): Photo[] =>
  JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT_ID)) || '[]');

const photo = (over: Partial<Photo> = {}): Partial<Photo> => ({
  id: 'p1',
  eventId: EVENT_ID,
  likedByGuestIds: [],
  likesCount: 0,
  reactions: [],
  comments: [],
  commentsCount: 0,
  status: 'approved',
  ...over,
});

/**
 * What the API client throws when the server refuses the guest credential.
 * Detected on `code`, not on the HTTP status - photoService only forgets an
 * identity for these two, so an ordinary 401 does not wipe a valid guest.
 */
const identityRejected = (code = 'GUEST_TOKEN_REQUIRED') =>
  Object.assign(new Error('Guest identity rejected'), { code });

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('toggleLikePhoto', () => {
  it('adds a like and keeps the count in step', () => {
    const { ctx, notify } = harness([photo()]);
    vi.spyOn(photosApi, 'toggleLike').mockResolvedValue({} as never);

    toggleLikePhoto(ctx, 'p1', 'g1');

    expect(stored()[0].likedByGuestIds).toEqual(['g1']);
    expect(stored()[0].likesCount).toBe(1);
    expect(notify).toHaveBeenCalled();
  });

  it('removes an existing like', () => {
    const { ctx } = harness([photo({ likedByGuestIds: ['g1', 'g2'], likesCount: 2 })]);
    vi.spyOn(photosApi, 'toggleLike').mockResolvedValue({} as never);

    toggleLikePhoto(ctx, 'p1', 'g1');

    expect(stored()[0].likedByGuestIds).toEqual(['g2']);
    expect(stored()[0].likesCount).toBe(1);
  });

  it('leaves other photos alone', () => {
    const { ctx } = harness([photo({ id: 'p1' }), photo({ id: 'p2' })]);
    vi.spyOn(photosApi, 'toggleLike').mockResolvedValue({} as never);

    toggleLikePhoto(ctx, 'p1', 'g1');

    expect(stored()[1].likedByGuestIds).toEqual([]);
  });

  it('sends the guest token so the server can attribute the like', () => {
    const { ctx } = harness([photo()]);
    const api = vi.spyOn(photosApi, 'toggleLike').mockResolvedValue({} as never);

    toggleLikePhoto(ctx, 'p1', 'g1');

    expect(api).toHaveBeenCalledWith('p1', 'g1', 'tok-1');
  });

  it('keeps the local like when the sync fails', async () => {
    const { ctx } = harness([photo()]);
    vi.spyOn(photosApi, 'toggleLike').mockRejectedValue(new Error('offline'));

    toggleLikePhoto(ctx, 'p1', 'g1');
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());

    // Offline must not undo what the guest just did on screen.
    expect(stored()[0].likedByGuestIds).toEqual(['g1']);
  });

  it('forgets a guest identity the server has rejected', async () => {
    const { ctx, forgetGuestIdentity } = harness([photo()]);
    vi.spyOn(photosApi, 'toggleLike').mockRejectedValue(identityRejected());

    toggleLikePhoto(ctx, 'p1', 'g1');

    await vi.waitFor(() => expect(forgetGuestIdentity).toHaveBeenCalledWith(EVENT_ID));
  });
});

describe('togglePhotoReaction', () => {
  it('adds a reaction, and each emoji is independent of the others', () => {
    const { ctx } = harness([photo({ reactions: [{ reaction: 'heart', guestId: 'g1' }] })]);
    vi.spyOn(photosApi, 'toggleReaction').mockResolvedValue({} as never);

    togglePhotoReaction(ctx, 'p1', 'clap', 'g1');

    expect(stored()[0].reactions).toHaveLength(2);
  });

  it('removes only the matching guest-and-emoji pair', () => {
    const { ctx } = harness([
      photo({
        reactions: [
          { reaction: 'heart', guestId: 'g1' },
          { reaction: 'heart', guestId: 'g2' },
        ],
      }),
    ]);
    vi.spyOn(photosApi, 'toggleReaction').mockResolvedValue({} as never);

    togglePhotoReaction(ctx, 'p1', 'heart', 'g1');

    expect(stored()[0].reactions).toEqual([{ reaction: 'heart', guestId: 'g2' }]);
  });

  it('ignores a photo id that is not present', () => {
    const { ctx } = harness([photo({ id: 'p1' })]);
    vi.spyOn(photosApi, 'toggleReaction').mockResolvedValue({} as never);

    togglePhotoReaction(ctx, 'nope', 'heart', 'g1');

    expect(stored()[0].reactions).toEqual([]);
  });

  it('forgets a rejected guest identity', async () => {
    const { ctx, forgetGuestIdentity } = harness([photo()]);
    vi.spyOn(photosApi, 'toggleReaction').mockRejectedValue(identityRejected());

    togglePhotoReaction(ctx, 'p1', 'heart', 'g1');

    await vi.waitFor(() => expect(forgetGuestIdentity).toHaveBeenCalledWith(EVENT_ID));
  });
});

describe('addComment', () => {
  it('refuses an empty or whitespace-only comment', () => {
    const { ctx } = harness([photo()]);
    const api = vi.spyOn(photosApi, 'addComment');

    addComment(ctx, 'p1', 'g1', 'Ana', '   ');

    expect(api).not.toHaveBeenCalled();
    expect(stored()[0].comments).toEqual([]);
  });

  it('appends a trimmed comment and keeps the count in step', () => {
    const { ctx } = harness([photo()]);
    vi.spyOn(photosApi, 'addComment').mockResolvedValue({ guestId: 'g1', guestToken: 't' } as never);

    addComment(ctx, 'p1', 'g1', 'Ana', '  Lovely  ');

    expect(stored()[0].comments).toHaveLength(1);
    expect(stored()[0].comments![0].commentText).toBe('Lovely');
    expect(stored()[0].commentsCount).toBe(1);
  });

  it('adopts the guest identity the server confirms', async () => {
    const { ctx, syncGuestFromServer } = harness([photo()]);
    vi.spyOn(photosApi, 'addComment').mockResolvedValue({
      guestId: 'server-g', guestToken: 'server-tok',
    } as never);

    addComment(ctx, 'p1', 'g1', 'Ana', 'Lovely');

    await vi.waitFor(() =>
      expect(syncGuestFromServer).toHaveBeenCalledWith(EVENT_ID, 'server-g', 'server-tok')
    );
  });

  it('forgets a rejected identity rather than retrying it', async () => {
    const { ctx, forgetGuestIdentity } = harness([photo()]);
    vi.spyOn(photosApi, 'addComment').mockRejectedValue(identityRejected());

    addComment(ctx, 'p1', 'g1', 'Ana', 'Lovely');

    await vi.waitFor(() => expect(forgetGuestIdentity).toHaveBeenCalledWith(EVENT_ID));
  });
});

describe('setPhotoStatus', () => {
  it('applies the status locally and syncs', () => {
    const { ctx, notify } = harness([photo({ status: 'pending' })]);
    const api = vi.spyOn(photosApi, 'setStatus').mockResolvedValue({} as never);

    setPhotoStatus(ctx, 'p1', 'approved');

    expect(stored()[0].status).toBe('approved');
    expect(api).toHaveBeenCalledWith('p1', 'approved');
    expect(notify).toHaveBeenCalled();
  });

  it('swallows a sync failure without disturbing the local state', async () => {
    const { ctx } = harness([photo({ status: 'pending' })]);
    vi.spyOn(photosApi, 'setStatus').mockRejectedValue(new Error('offline'));

    setPhotoStatus(ctx, 'p1', 'approved');
    await Promise.resolve();

    expect(stored()[0].status).toBe('approved');
  });
});

describe('deletePhoto', () => {
  it('removes the photo optimistically and asks the server', async () => {
    const { ctx } = harness([photo({ id: 'aaaaaaaa-1111-4222-8333-444455556666' })]);
    const api = vi.spyOn(photosApi, 'delete').mockResolvedValue({} as never);

    await deletePhoto(ctx, 'aaaaaaaa-1111-4222-8333-444455556666');

    expect(stored()).toHaveLength(0);
    expect(api).toHaveBeenCalled();
  });

  it('never sends a placeholder id the server has no row for', async () => {
    // addPhoto gives an optimistic photo `photo-<ts>-<rand>` until the round
    // trip reconciles it. Sending that to DELETE 400s on uuid validation, and
    // the rollback below then made the photo look undeletable.
    const { ctx } = harness([photo({ id: 'photo-1700000000-abc' })]);
    const api = vi.spyOn(photosApi, 'delete');

    await deletePhoto(ctx, 'photo-1700000000-abc');

    expect(stored()).toHaveLength(0);
    expect(api).not.toHaveBeenCalled();
  });

  it('restores the photo when the server refuses the delete', async () => {
    const id = 'aaaaaaaa-1111-4222-8333-444455556666';
    const { ctx } = harness([photo({ id })]);
    vi.spyOn(photosApi, 'delete').mockRejectedValue(new Error('403'));

    await deletePhoto(ctx, id);

    expect(stored().map((p) => p.id)).toEqual([id]);
  });

  it('does not restore anything when the photo was not there to begin with', async () => {
    const { ctx } = harness([photo({ id: 'p-other' })]);
    vi.spyOn(photosApi, 'delete').mockRejectedValue(new Error('403'));

    await deletePhoto(ctx, 'aaaaaaaa-1111-4222-8333-444455556666');

    expect(stored().map((p) => p.id)).toEqual(['p-other']);
  });
});

describe('reconcileFlushedPhoto (FE-03)', () => {
  const queued = (payload: Record<string, unknown>) =>
    ({ payload } as unknown as Parameters<typeof reconcileFlushedPhoto>[1]);

  it('replaces the temp-id row in place rather than adding a second one', () => {
    const { ctx } = harness([photo({ id: 'local-1', fullUrl: '' })]);

    reconcileFlushedPhoto(
      ctx,
      queued({ localId: 'local-1', eventId: EVENT_ID }),
      { id: 'server-1', fullUrl: 'https://cdn.example.com/p.jpg', guestId: 'g9' }
    );

    expect(stored()).toHaveLength(1);
    expect(stored()[0].id).toBe('server-1');
  });

  it('adopts the guest identity the upload response carries', () => {
    const { ctx, syncGuestFromServer } = harness([photo({ id: 'local-1' })]);

    reconcileFlushedPhoto(
      ctx,
      queued({ localId: 'local-1', eventId: EVENT_ID }),
      { id: 'server-1', guestId: 'g9', guestToken: 'tok-9' }
    );

    expect(syncGuestFromServer).toHaveBeenCalledWith(EVENT_ID, 'g9', 'tok-9');
  });

  it('does nothing without a localId to match', () => {
    const { ctx, notify } = harness([photo({ id: 'local-1' })]);

    reconcileFlushedPhoto(ctx, queued({ eventId: EVENT_ID }), { id: 'server-1' });

    expect(stored()[0].id).toBe('local-1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('does nothing when the server response carries no id', () => {
    const { ctx, notify } = harness([photo({ id: 'local-1' })]);

    reconcileFlushedPhoto(ctx, queued({ localId: 'local-1', eventId: EVENT_ID }), { ok: true });

    expect(stored()[0].id).toBe('local-1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('falls back to the active event when the queued item names none', () => {
    const { ctx } = harness([photo({ id: 'local-1' })]);

    reconcileFlushedPhoto(ctx, queued({ localId: 'local-1' }), { id: 'server-1' });

    expect(stored()[0].id).toBe('server-1');
  });
});

describe('getPhotos', () => {
  it('returns an empty list for an event with nothing stored', () => {
    const { ctx } = harness([]);
    expect(getPhotos(ctx, 'no-such-event')).toEqual([]);
  });
});
