import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  addPhoto,
  getPhotos,
  toggleLikePhoto,
  togglePhotoReaction,
  addComment,
  setPhotoStatus,
  deletePhoto,
  reconcileFlushedPhoto,
} from '../../src/services/photoService';
import { photosApi } from '../../src/api/photosApi';
import { ApiError } from '../../src/api/apiClient';
import { offlineQueue } from '../../src/services/offlineQueueService';
import { i18n } from '../../src/i18n';
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
  return { ctx, notify, forgetGuestIdentity, syncGuestFromServer, notifyError: ctx.notifyError as ReturnType<typeof vi.fn> };
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

  it('puts the photo back and tells the host when the server refuses', async () => {
    // This used to be swallowed: the badge moved, the count dropped, the
    // server said no, and the host heard nothing — the photo reappeared as
    // pending at the next sync, looking like the app had lost their decision.
    const { ctx, notifyError } = harness([photo({ status: 'pending' })]);
    vi.spyOn(photosApi, 'setStatus').mockRejectedValue(new Error('Session expired'));

    setPhotoStatus(ctx, 'p1', 'approved');
    await Promise.resolve();
    await Promise.resolve();

    expect(stored()[0].status).toBe('pending');
    expect(notifyError).toHaveBeenCalledWith('Session expired');
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

describe('an identity the server has stopped honouring', () => {
  it('forgets it when the server says the identity is required', async () => {
    // GUEST_IDENTITY_REQUIRED arrived with the 401 fix and nothing asserted
    // it: only its sibling code was ever tested, so half the condition could
    // be inverted with the suite still green.
    const { ctx, forgetGuestIdentity } = harness([photo()]);
    vi.spyOn(photosApi, 'toggleReaction').mockRejectedValue(identityRejected('GUEST_IDENTITY_REQUIRED'));

    togglePhotoReaction(ctx, 'p1', 'heart', 'g1');

    await vi.waitFor(() => expect(forgetGuestIdentity).toHaveBeenCalledWith(EVENT_ID));
  });

  it('keeps the identity when the failure is not an object at all', async () => {
    // A guest's identity is their link to every photo they have taken. A
    // rejection that carries no code — a string, a network stack throwing
    // something odd — is not evidence the server refused the credential.
    const { ctx, forgetGuestIdentity } = harness([photo()]);
    vi.spyOn(photosApi, 'toggleLike').mockRejectedValue('offline');

    toggleLikePhoto(ctx, 'p1', 'g1');

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(forgetGuestIdentity).not.toHaveBeenCalled();
  });

  it('survives a rejection that carries nothing at all', async () => {
    // A rejected promise with no value reaches the same handler. Reading a
    // property off it throws inside the catch, which becomes an unhandled
    // rejection nobody sees and no code recovers from.
    const { ctx, forgetGuestIdentity } = harness([photo()]);
    // null specifically: typeof null is 'object', so a guard that checks the
    // type without checking for null first reads .code off it and throws.
    vi.spyOn(photosApi, 'toggleLike').mockRejectedValue(null);

    toggleLikePhoto(ctx, 'p1', 'g1');

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(forgetGuestIdentity).not.toHaveBeenCalled();
    expect(stored()[0].likedByGuestIds).toEqual(['g1']);
  });

  it('keeps the identity for an ordinary refusal', async () => {
    const { ctx, forgetGuestIdentity } = harness([photo()]);
    vi.spyOn(photosApi, 'toggleLike').mockRejectedValue(identityRejected('RATE_LIMITED'));

    toggleLikePhoto(ctx, 'p1', 'g1');

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(forgetGuestIdentity).not.toHaveBeenCalled();
  });
});

describe('reacting after somebody else already has', () => {
  it('adds my reaction rather than treating theirs as mine', () => {
    // Whether I have reacted is decided by guest *and* emoji. Matching on the
    // emoji alone reads another guest's heart as my own, and my tap then
    // removes nothing and adds nothing — the reaction simply never appears.
    const { ctx } = harness([photo({ reactions: [{ guestId: 'someone-else', reaction: 'heart' }] })]);
    vi.spyOn(photosApi, 'toggleReaction').mockResolvedValue({} as never);

    togglePhotoReaction(ctx, 'p1', 'heart', 'g1');

    expect(stored()[0].reactions).toEqual([
      { guestId: 'someone-else', reaction: 'heart' },
      { reaction: 'heart', guestId: 'g1' },
    ]);
  });
});

describe('addPhoto', () => {
  const capture = {
    guestId: 'g1',
    guestName: 'Ana',
    fullUrl: 'data:image/jpeg;base64,AAAA',
  };

  // Uploads run one at a time (FE-06, `photoUploadThrottle`), and the slot is
  // module state. A mock that never resolves holds it for every test after
  // it, so each of these resolves.
  const respond = (body: Record<string, unknown>) =>
    vi.spyOn(photosApi, 'create').mockResolvedValue(body as never);

  it('shows the full image until a thumbnail exists', async () => {
    const { ctx } = harness();
    respond({});

    await addPhoto(ctx, capture);

    expect(stored()[0].thumbnailUrl).toBe(capture.fullUrl);
  });

  it('records an unedited capture as the original', async () => {
    const { ctx } = harness();
    respond({});

    await addPhoto(ctx, capture);

    expect(stored()[0].filterApplied).toBe('original');
  });

  it('keeps the guest their own preview while the photo is quarantined', async () => {
    // MED-03/SEC-M5: a quarantined photo's URLs are not publicly reachable.
    // Writing them over the guest's local capture would blank their own card
    // until a host approves it.
    const { ctx } = harness();
    respond({
      id: 'srv-1',
      guestId: 'g1',
      fullUrl: 'https://cdn.example/quarantine/events/e/p.jpg',
      thumbnailUrl: 'https://cdn.example/quarantine/events/e/thumb.jpg',
      status: 'pending',
    });

    await addPhoto(ctx, capture);

    await vi.waitFor(() => expect(stored()[0].id).toBe('srv-1'));
    expect(stored()[0].fullUrl).toBe(capture.fullUrl);
    expect(stored()[0].thumbnailUrl).toBe(capture.fullUrl);
  });

  it('takes the server URLs once the photo is public', async () => {
    const { ctx } = harness();
    respond({
      id: 'srv-1',
      guestId: 'g1',
      fullUrl: 'https://cdn.example/events/e/p.jpg',
      thumbnailUrl: 'https://cdn.example/events/e/thumb.jpg',
      status: 'approved',
    });

    await addPhoto(ctx, capture);

    await vi.waitFor(() => expect(stored()[0].fullUrl).toBe('https://cdn.example/events/e/p.jpg'));
  });

  it('merges the server row into the photo it was for and no other', async () => {
    const { ctx } = harness([photo({ id: 'older', caption: 'unchanged' })]);
    respond({
      id: 'srv-1',
      guestId: 'g1',
      caption: 'from the server',
      fullUrl: 'https://cdn.example/events/e/p.jpg',
    });

    await addPhoto(ctx, capture);

    await vi.waitFor(() => expect(stored().map((p) => p.id)).toContain('srv-1'));
    expect(stored().find((p) => p.id === 'older')?.caption).toBe('unchanged');
  });

  it('leaves the local row alone when the response carries no id', async () => {
    // Nothing to reconcile against, so the guest keeps the row they can see
    // rather than having it merged with an identity-less response.
    const { ctx, syncGuestFromServer } = harness();
    const api = respond({});

    const created = await addPhoto(ctx, capture);

    await vi.waitFor(() => expect(api).toHaveBeenCalled());
    expect(stored()[0].id).toBe(created.id);
    expect(syncGuestFromServer).not.toHaveBeenCalled();
  });
});

describe('reading another event', () => {
  it('reads the event it is asked for, not the active one', () => {
    // getPhotos(ctx, id) is how the host dashboard reads an album it is not
    // currently standing in.
    const OTHER = 'aaaaaaaa-1111-4222-8333-444455556666';
    localStorage.setItem(STORAGE_KEYS.PHOTOS(OTHER), JSON.stringify([photo({ id: 'other-1' })]));
    const { ctx } = harness([photo({ id: 'active-1' })]);

    expect(getPhotos(ctx, OTHER).map((p) => p.id)).toEqual(['other-1']);
    expect(getPhotos(ctx).map((p) => p.id)).toEqual(['active-1']);
  });
});

describe('a comment on a photo that has none', () => {
  it('starts the list rather than throwing', () => {
    const { ctx } = harness([photo({ comments: undefined, commentsCount: undefined })]);

    addComment(ctx, 'p1', 'g1', 'Ana', 'Beautiful');

    expect(stored()[0].comments).toHaveLength(1);
    expect(stored()[0].commentsCount).toBe(1);
  });
});

describe('setPhotoStatus rollback', () => {
  it('puts back only the photo whose change was refused', async () => {
    const { ctx } = harness([photo({ id: 'p1', status: 'pending' }), photo({ id: 'p2', status: 'rejected' })]);
    vi.spyOn(photosApi, 'setStatus').mockRejectedValue(new Error('Forbidden'));

    setPhotoStatus(ctx, 'p1', 'approved');

    await vi.waitFor(() => expect(stored().find((p) => p.id === 'p1')?.status).toBe('pending'));
    expect(stored().find((p) => p.id === 'p2')?.status).toBe('rejected');
  });
});

/**
 * N-150 — the server refusing a photo is not the network failing.
 *
 * Every failed upload used to go to the offline queue. On a full album the
 * guest was told the photo was sent, saw it at the top of the feed and in
 * "Моите снимки", and the phone retried it five times before dropping it
 * with a message about having had no connection. A refusal no retry can
 * change has to come off the phone at once, with the reason said.
 */
describe('addPhoto when the server refuses the photo', () => {
  const capture = { guestId: 'g1', guestName: 'Ana', fullUrl: 'data:image/jpeg;base64,AAAA' };

  it('takes a photo the full album refused off the phone and says why', async () => {
    const { ctx, notifyError } = harness();
    vi.spyOn(photosApi, 'create').mockRejectedValue(
      new ApiError('Достигнахте лимита на снимките за вашия план.', 403, undefined, 'TIER_LIMIT_REACHED')
    );
    const enqueue = vi.spyOn(offlineQueue, 'enqueue').mockResolvedValue(null);

    await addPhoto(ctx, capture);

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith(i18n.t('upload.album_full')));
    expect(enqueue).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(0);
  });

  it("takes off a photo past the guest's own limit, giving the limit", async () => {
    const { ctx, notifyError } = harness();
    vi.spyOn(photosApi, 'create').mockRejectedValue(
      new ApiError('Достигнахте лимита от 3 снимки.', 429, undefined, 'GUEST_PHOTO_LIMIT_REACHED')
    );
    const enqueue = vi.spyOn(offlineQueue, 'enqueue').mockResolvedValue(null);

    await addPhoto(ctx, capture);

    await vi.waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(i18n.t('upload.photo_not_sent', { reason: 'Достигнахте лимита от 3 снимки.' }))
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(0);
  });

  it('still queues a photo when the network failed', async () => {
    const { ctx, notifyError } = harness();
    vi.spyOn(photosApi, 'create').mockRejectedValue(new TypeError('Failed to fetch'));
    const enqueue = vi.spyOn(offlineQueue, 'enqueue').mockResolvedValue(null);

    await addPhoto(ctx, capture);

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(notifyError).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(1);
  });

  // A 403 the app sends always carries a code. One without came from
  // something between the phone and the server - a venue's captive portal or
  // proxy - and the photo must survive it.
  it('still queues a photo met by a bare 403 from the venue network', async () => {
    const { ctx, notifyError } = harness();
    vi.spyOn(photosApi, 'create').mockRejectedValue(new ApiError('Нямате право да направите това.', 403));
    const enqueue = vi.spyOn(offlineQueue, 'enqueue').mockResolvedValue(null);

    await addPhoto(ctx, capture);

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(notifyError).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(1);
  });

  it('still queues a photo the rate limiter turned away, which a later try can send', async () => {
    const { ctx } = harness();
    vi.spyOn(photosApi, 'create').mockRejectedValue(new ApiError('Too many uploads', 429));
    const enqueue = vi.spyOn(offlineQueue, 'enqueue').mockResolvedValue(null);

    await addPhoto(ctx, capture);

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(stored()).toHaveLength(1);
  });
});
