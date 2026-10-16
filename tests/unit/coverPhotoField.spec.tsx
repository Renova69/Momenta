import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { CoverPhotoField } from '../../src/components/host/dashboard/CoverPhotoField';
import * as compressionService from '../../src/services/compressionService';
import { i18n } from '../../src/i18n';
import type { Photo } from '../../src/types';
import { photoAlt } from '../../src/utils/photoAlt';

/**
 * N-139 — the studio had no way to set the album's cover, so every album's
 * top section was the gradient alone. The cover can now be uploaded (the
 * usual case before the wedding, when the album is still empty), chosen from
 * the album's photos guests can already see, or removed.
 */

function photo(id: string, over: Partial<Photo> = {}): Photo {
  return {
    id,
    eventId: 'e1',
    guestId: 'g1',
    guestName: 'Ana',
    thumbnailUrl: `https://cdn.example/${id}-thumb.jpg`,
    fullUrl: `https://cdn.example/${id}.jpg`,
    status: 'approved',
    createdAt: '2026-10-01T18:00:00.000Z',
    ...over,
  } as Photo;
}

function field(over: Partial<React.ComponentProps<typeof CoverPhotoField>> = {}) {
  const props = {
    coverImageUrl: '',
    photos: [] as Photo[],
    onSetCover: vi.fn().mockResolvedValue(undefined),
    onRemoveCover: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  render(<CoverPhotoField {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the album cover in the studio (N-139)', () => {
  it('says there is no cover yet, and offers no removal', () => {
    field();

    expect(screen.getByText(i18n.t('host.cover_none'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('host.cover_remove') })).not.toBeInTheDocument();
  });

  it('shows the cover the album has', () => {
    field({ coverImageUrl: 'https://cdn.example/cover-1-abc.jpg' });

    expect(screen.getByRole('img', { name: i18n.t('host.cover_current_alt') })).toHaveAttribute(
      'src',
      'https://cdn.example/cover-1-abc.jpg'
    );
  });

  it('uploads a photo from the device, made phone-sized first', async () => {
    const compress = vi
      .spyOn(compressionService, 'compressAndFilterImage')
      .mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,SMALL', width: 1600, height: 1067 });
    const { onSetCover } = field();
    const file = new File([new Uint8Array([1, 2, 3])], 'engagement.jpg', { type: 'image/jpeg' });

    fireEvent.change(screen.getByLabelText(i18n.t('host.cover_upload')), { target: { files: [file] } });

    await waitFor(() => expect(onSetCover).toHaveBeenCalledWith({ image: 'data:image/jpeg;base64,SMALL' }));
    expect(compress).toHaveBeenCalledWith(file, expect.objectContaining({ maxWidth: 1600, maxHeight: 1600 }));
  });

  it('offers only the photos guests can already see', () => {
    field({
      photos: [
        photo('shown'),
        photo('featured', { status: 'featured' }),
        photo('pending', { status: 'pending' }),
        photo('rejected', { status: 'rejected' }),
        photo('locked', { isLocked: true }),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: i18n.t('host.cover_pick') }));

    const dialog = screen.getByRole('dialog', { name: i18n.t('host.cover_pick_title') });
    const choices = within(dialog).getAllByRole('button', { name: photoAlt(photo('x')) });
    expect(choices).toHaveLength(2);
  });

  it('sets the chosen photo as the cover and closes the picker', async () => {
    const { onSetCover } = field({ photos: [photo('p1')] });

    fireEvent.click(screen.getByRole('button', { name: i18n.t('host.cover_pick') }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: photoAlt(photo('p1')) }));

    await waitFor(() => expect(onSetCover).toHaveBeenCalledWith({ photoId: 'p1' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says so when the album has no photos to choose from yet', () => {
    field();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('host.cover_pick') }));

    expect(within(screen.getByRole('dialog')).getByText(i18n.t('host.cover_pick_empty'))).toBeInTheDocument();
  });

  it('removes the cover once the host confirms', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onRemoveCover } = field({ coverImageUrl: 'https://cdn.example/cover-1-abc.jpg' });

    fireEvent.click(screen.getByRole('button', { name: i18n.t('host.cover_remove') }));

    await waitFor(() => expect(onRemoveCover).toHaveBeenCalled());
  });

  it('keeps the cover when the host thinks better of it', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onRemoveCover } = field({ coverImageUrl: 'https://cdn.example/cover-1-abc.jpg' });

    fireEvent.click(screen.getByRole('button', { name: i18n.t('host.cover_remove') }));

    expect(onRemoveCover).not.toHaveBeenCalled();
  });

  it('says why a cover was not saved', async () => {
    field({ photos: [photo('p1')], onSetCover: vi.fn().mockRejectedValue(new Error(i18n.t('error.photo_not_public'))) });

    fireEvent.click(screen.getByRole('button', { name: i18n.t('host.cover_pick') }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: photoAlt(photo('p1')) }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('error.photo_not_public'));
  });
});
