import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError } from '../../src/api/apiClient';
import { photosApi } from '../../src/api/photosApi';
import { eventsApi } from '../../src/api/eventsApi';
import { guestsApi } from '../../src/api/guestsApi';
import { questsApi } from '../../src/api/questsApi';
import { audioApi } from '../../src/api/audioApi';
import { Photo, WeddingEvent, Guest, ScavengerQuest, AudioGuestbookEntry } from '../../src/types';

function createMockResponse<T>(data: T, status = 200, ok = true): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
    blob: async () => new Blob([JSON.stringify(data)]),
    arrayBuffer: async () => new ArrayBuffer(0),
    formData: async () => new FormData(),
    clone: () => createMockResponse(data, status, ok),
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'basic',
    url: '',
  } as Response;
}

describe('API Client Layer Spec', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('handles ApiError and error parsing in apiFetch', async () => {
    const err = new ApiError('Custom error', 404, { field: 'email' });
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(404);
    expect(err.details).toEqual({ field: 'email' });

    // Mock 400 error response
    global.fetch = vi.fn().mockResolvedValue(
      createMockResponse({ error: 'Invalid payload', details: ['Missing name'] }, 400, false)
    );

    await expect(apiFetch('/api/test')).rejects.toThrow('Invalid payload');

    // Mock non-json error response
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('Not JSON');
      },
    } as unknown as Response);

    await expect(apiFetch('/api/test')).rejects.toThrow('HTTP Error 500');
  });

  it('handles FormData uploads without Content-Type header override', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createMockResponse({ url: 'https://cdn.example.com/uploaded.jpg' })
    );

    const formData = new FormData();
    formData.append('test', '123');

    await apiFetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/upload'),
      expect.objectContaining({
        headers: expect.not.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
  });

  it('photosApi executes CRUD requests with auth headers', async () => {
    localStorage.setItem('wedmoments_host_token', 'test-token-123');

    const mockPhotos: Partial<Photo>[] = [{ id: 'p1', caption: 'Nice photo' }];
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(mockPhotos));

    const list = await photosApi.list('10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01');
    expect(list.length).toBe(1);

    // Like
    global.fetch = vi.fn().mockResolvedValue(createMockResponse({ isLiked: true, likesCount: 5 }));

    const likeRes = await photosApi.toggleLike('p1', 'g1');
    expect(likeRes.isLiked).toBe(true);

    // Comment
    global.fetch = vi.fn().mockResolvedValue(createMockResponse({ id: 'c1', commentText: 'Great!' }));

    const commentRes = await photosApi.addComment('p1', 'g1', 'Guest', 'Great!');
    expect(commentRes.commentText).toBe('Great!');

    // Status update & delete
    global.fetch = vi.fn().mockResolvedValue(createMockResponse({ success: true }));

    const updateStatusRes = await photosApi.setStatus('p1', 'featured');
    expect(updateStatusRes.success).toBe(true);

    await photosApi.delete('p1');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/photos/p1'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('eventsApi handles getBySlug, getById, create, update, and QR canvas config', async () => {
    const mockEvent: Partial<WeddingEvent> = { id: 'e1', slug: 'wedding-slug' };
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(mockEvent));

    const event = await eventsApi.getBySlug('wedding-slug');
    expect(event?.slug).toBe('wedding-slug');

    const eventById = await eventsApi.getById('e1');
    expect(eventById?.id).toBe('e1');

    const created = await eventsApi.create({
      title: 'New Wedding',
      slug: 'new-wedding',
      hostName: 'Host',
      planTier: 'free',
      eventDate: '2026-09-18T16:30:00Z',
    });
    expect(created.id).toBe('e1');

    const updated = await eventsApi.update('e1', { venueName: 'New Venue' });
    expect(updated.slug).toBe('wedding-slug');

    const qrConfig = await eventsApi.getQRConfig('e1');
    expect(qrConfig).toBeDefined();

    await eventsApi.updateQRConfig('e1', { headline: 'New Headline' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/events/e1/qr-config'),
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('guestsApi registers and queries guests by fingerprint', async () => {
    const mockGuest: Partial<Guest> = { id: 'guest-uuid-1', name: 'James' };
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(mockGuest));

    const guest = await guestsApi.register({ eventId: 'e1', name: 'James', tableNumber: 'Table 2', deviceFingerprint: 'fp-123' });
    expect(guest.id).toBe('guest-uuid-1');

    const lookup = await guestsApi.lookup('e1', 'fp-123');
    expect(lookup?.id).toBe('guest-uuid-1');
  });

  it('questsApi lists, completes, creates, and deletes challenges', async () => {
    const mockQuests: Partial<ScavengerQuest>[] = [{ id: 'q1', title: 'First Dance' }];
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(mockQuests));

    const quests = await questsApi.list('e1');
    expect(quests.length).toBe(1);

    global.fetch = vi.fn().mockResolvedValue(createMockResponse({ success: true, points: 15 }));

    const completion = await questsApi.complete('q1', 'g1', 'p1');
    expect(completion.success).toBe(true);

    const newQuest: Partial<ScavengerQuest> = { id: 'q2', title: 'Champagne Tower' };
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(newQuest));

    const createdQuest = await questsApi.create('e1', { title: 'Champagne Tower', points: 20 });
    expect(createdQuest.id).toBe('q2');

    await questsApi.delete('q2');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/quests/q2'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('audioApi lists and creates voice recordings', async () => {
    const mockAudio: Partial<AudioGuestbookEntry>[] = [{ id: 'a1', durationSeconds: 20 }];
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(mockAudio));

    const audioList = await audioApi.list('e1');
    expect(audioList.length).toBe(1);

    const createdAudio: Partial<AudioGuestbookEntry> = { id: 'a1', durationSeconds: 20 };
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(createdAudio));

    const created = await audioApi.create({
      eventId: 'e1',
      guestId: 'g1',
      guestName: 'Guest',
      audioBlob: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm' }),
      durationSeconds: 20,
    });
    expect(created.durationSeconds).toBe(20);
  });

  it('audioApi identifies the device in a header, where the rate limiter can see it', async () => {
    // The limiter runs before multer, so it cannot read a field inside this
    // multipart body — req.body is not parsed yet — and falls back to the
    // caller's IP. At a venue every guest shares the building's NAT address,
    // so that fallback hands the entire reception one shared budget of twenty
    // recordings a minute and tells the twenty-first guest that they are
    // uploading too fast. The header is the only identifier available that
    // early (server/middleware/rateLimit.ts, deviceKey).
    global.fetch = vi.fn().mockResolvedValue(createMockResponse({ id: 'a1' }));

    await audioApi.create({
      eventId: 'e1',
      guestId: 'g1',
      audioBlob: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm' }),
      durationSeconds: 20,
    });

    const headers = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .headers as Record<string, string>;
    expect(headers['x-device-fingerprint']).toBeTruthy();
    // And the browser still gets to set the multipart boundary itself.
    expect(headers).not.toHaveProperty('Content-Type');
  });
});
