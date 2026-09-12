import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PhotoCard } from '../../src/components/gallery/PhotoCard';
import { Guest, Photo } from '../../src/types';

/**
 * H1 — the feed card for a photo whose inline preview had to be shed.
 *
 * `persistPhotos` drops a capture's base64 `data:` URL rather than drop the
 * record when localStorage is full, and `readPhotos` puts it back from memory
 * for the rest of the session. After a reload that memory is gone, so the row
 * is real but has no image to draw until the upload lands and the server URL
 * replaces it.
 *
 * `<img src="">` renders as the browser's broken-image icon, which tells the
 * guest their photo is lost at the exact moment it is in fact still uploading.
 */

const EVENT_ID = 'ab12cd34-5678-49ab-8cde-f01234567890';

const GUEST: Guest = {
  id: 'guest-1',
  eventId: EVENT_ID,
  name: 'Guest',
  createdAt: '2026-01-10T12:00:00.000Z',
};

function photo(id: string, preview: string): Photo {
  return {
    id,
    eventId: EVENT_ID,
    guestId: 'guest-1',
    guestName: 'Guest',
    storagePath: `events/${EVENT_ID}/${id}.jpg`,
    thumbnailUrl: preview,
    fullUrl: preview,
    status: 'approved',
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    createdAt: '2026-01-10T12:00:00.000Z',
  };
}

const noop = () => {};

describe('PhotoCard preview fallback (H1)', () => {
  it('shows an uploading placeholder instead of a broken image', () => {
    render(
      <PhotoCard
        photo={photo('photo-shed', '')}
        currentGuest={GUEST}
        onLike={noop}
        onReact={noop}
        onOpenComments={noop}
        onOpenLightbox={noop}
      />
    );

    expect(screen.getByTestId('photo-preview-pending')).toBeInTheDocument();
    expect(document.querySelector('img[src=""]')).toBeNull();
  });

  it('renders the image normally once a URL is present', () => {
    render(
      <PhotoCard
        photo={photo('server-uuid', 'https://cdn.example.com/p.jpg')}
        currentGuest={GUEST}
        onLike={noop}
        onReact={noop}
        onOpenComments={noop}
        onOpenLightbox={noop}
      />
    );

    expect(screen.queryByTestId('photo-preview-pending')).toBeNull();
    expect(document.querySelector('img[src="https://cdn.example.com/p.jpg"]')).not.toBeNull();
  });

  it('falls back to fullUrl when only the thumbnail was shed', () => {
    const partial = { ...photo('photo-partial', ''), fullUrl: 'https://cdn.example.com/full.jpg' };

    render(
      <PhotoCard
        photo={partial}
        currentGuest={GUEST}
        onLike={noop}
        onReact={noop}
        onOpenComments={noop}
        onOpenLightbox={noop}
      />
    );

    expect(screen.queryByTestId('photo-preview-pending')).toBeNull();
    expect(document.querySelector('img[src="https://cdn.example.com/full.jpg"]')).not.toBeNull();
  });
});
