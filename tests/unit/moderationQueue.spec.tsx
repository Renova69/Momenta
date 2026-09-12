import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { ModerationQueue } from '../../src/components/host/ModerationQueue';
import { Photo } from '../../src/types';
import { i18n } from '../../src/i18n';

// G1 (OPEN_ITEMS.md) — a paid feature (isModerationEnabled): a bug here means
// unmoderated photos ship straight to the live feed/projector unreviewed.

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: `p-${Math.random().toString(36).slice(2, 8)}`,
    eventId: 'e1',
    guestId: 'g1',
    guestName: 'Silvia',
    guestTable: 'Table 4',
    storagePath: '/uploads/x.jpg',
    thumbnailUrl: 'https://cdn.example/x-thumb.jpg',
    fullUrl: 'https://cdn.example/x.jpg',
    status: 'pending',
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    likedByGuestIds: [],
    comments: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Photo;
}

afterEach(() => cleanup());

describe('ModerationQueue', () => {
  it('shows the "all caught up" empty state when nothing is pending', () => {
    render(<ModerationQueue photos={[]} onSetStatus={vi.fn()} onDeletePhoto={vi.fn()} />);
    expect(screen.getByText(i18n.t('host.all_caught_up'))).toBeInTheDocument();
  });

  it('lists pending photos with guest name/table and excludes rejected/approved photos from the queue', () => {
    const pending = photo({ id: 'pending-1', guestName: 'Martin', guestTable: 'Table 2' });
    const rejected = photo({ id: 'rejected-1', status: 'rejected', guestName: 'Rejected Guest' });
    render(<ModerationQueue photos={[pending, rejected]} onSetStatus={vi.fn()} onDeletePhoto={vi.fn()} />);

    expect(screen.getByText('Martin (Table 2)')).toBeInTheDocument();
    expect(screen.queryByText(/Rejected Guest/)).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('host.all_caught_up'))).not.toBeInTheDocument();
  });

  it('approves, features, and rejects a pending photo via its action buttons', () => {
    const onSetStatus = vi.fn();
    const p = photo({ id: 'p1' });
    render(<ModerationQueue photos={[p]} onSetStatus={onSetStatus} onDeletePhoto={vi.fn()} />);

    fireEvent.click(screen.getByText(i18n.t('host.approve')));
    expect(onSetStatus).toHaveBeenCalledWith('p1', 'approved');

    fireEvent.click(screen.getByText(i18n.t('host.feature')));
    expect(onSetStatus).toHaveBeenCalledWith('p1', 'featured');

    fireEvent.click(screen.getByTitle(i18n.t('host.reject')));
    expect(onSetStatus).toHaveBeenCalledWith('p1', 'rejected');
  });

  it('merges featured and approved photos into the active grid, featured first and badged', () => {
    const approved = photo({ id: 'approved-1', status: 'approved' });
    const featured = photo({ id: 'featured-1', status: 'featured' });
    render(<ModerationQueue photos={[approved, featured]} onSetStatus={vi.fn()} onDeletePhoto={vi.fn()} />);

    // Both live in the "active" section (count reflects both).
    const heading = screen.getByText(new RegExp(`${i18n.t('host.active_photos')} \\(2\\)`));
    expect(heading).toBeInTheDocument();

    const images = screen.getAllByRole('img', { name: 'Approved' });
    expect(images).toHaveLength(2);
    expect(screen.getAllByText(i18n.t('host.tv_featured')).length).toBeGreaterThanOrEqual(1);
  });

  it('toggles feature/unfeature on the active grid based on the photo\'s current status', () => {
    const onSetStatus = vi.fn();
    const approved = photo({ id: 'approved-1', status: 'approved' });
    const featured = photo({ id: 'featured-1', status: 'featured' });
    render(<ModerationQueue photos={[approved, featured]} onSetStatus={onSetStatus} onDeletePhoto={vi.fn()} />);

    fireEvent.click(screen.getByText(i18n.t('host.feature_tv')));
    expect(onSetStatus).toHaveBeenCalledWith('approved-1', 'featured');

    fireEvent.click(screen.getByText(i18n.t('host.unfeature')));
    expect(onSetStatus).toHaveBeenCalledWith('featured-1', 'approved');
  });

  it('deletes a photo from the active grid after confirming', () => {
    const onDeletePhoto = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const approved = photo({ id: 'approved-1', status: 'approved' });
    render(<ModerationQueue photos={[approved]} onSetStatus={vi.fn()} onDeletePhoto={onDeletePhoto} />);

    fireEvent.click(screen.getByText(i18n.t('host.delete')));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onDeletePhoto).toHaveBeenCalledWith('approved-1');
    confirmSpy.mockRestore();
  });

  it('does not delete when the confirmation dialog is dismissed', () => {
    const onDeletePhoto = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const approved = photo({ id: 'approved-1', status: 'approved' });
    render(<ModerationQueue photos={[approved]} onSetStatus={vi.fn()} onDeletePhoto={onDeletePhoto} />);

    fireEvent.click(screen.getByText(i18n.t('host.delete')));
    expect(onDeletePhoto).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('multi-selects photos and deletes them all after one confirmation', () => {
    const onDeletePhoto = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const approved = photo({ id: 'approved-1', status: 'approved' });
    const featured = photo({ id: 'featured-1', status: 'featured' });
    render(<ModerationQueue photos={[approved, featured]} onSetStatus={vi.fn()} onDeletePhoto={onDeletePhoto} />);

    fireEvent.click(screen.getByText(i18n.t('host.select_photos')));
    const images = screen.getAllByRole('img', { name: 'Approved' });
    fireEvent.click(images[0].parentElement as Element);
    fireEvent.click(images[1].parentElement as Element);

    fireEvent.click(screen.getByText(i18n.t('host.delete_selected')));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onDeletePhoto).toHaveBeenCalledWith('featured-1');
    expect(onDeletePhoto).toHaveBeenCalledWith('approved-1');
    expect(onDeletePhoto).toHaveBeenCalledTimes(2);
    confirmSpy.mockRestore();
  });

  it('shows the pending count and featured count in the banner', () => {
    const pending = [photo({ id: 'p1' }), photo({ id: 'p2' })];
    const featured = photo({ id: 'f1', status: 'featured' });
    render(<ModerationQueue photos={[...pending, featured]} onSetStatus={vi.fn()} onDeletePhoto={vi.fn()} />);

    expect(screen.getByText(i18n.t('moderation.pending_count', { count: 2 }))).toBeInTheDocument();
  });
});
