import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { CameraCaptureModal } from '../../src/components/camera/CameraCaptureModal';
import { Guest } from '../../src/types';
import { i18n } from '../../src/i18n';

/**
 * SEC-W3 — bulk photo selection had no cap on file count. Each file piled up
 * a full-size data: URL in memory sequentially, before any of them finished
 * compressing; 20+ photos from a phone camera was enough to exceed mobile RAM
 * budgets and get the tab killed by the OS. This covers the fix: a hard cap
 * on how many files one bulk selection processes (MAX_BULK_UPLOAD_FILES),
 * with the rest silently dropped and a notice shown for what happened.
 */

afterEach(() => cleanup());

const mockGuest: Guest = {
  id: 'guest-1',
  eventId: 'event-1',
  name: 'Spec Guest',
  createdAt: new Date().toISOString(),
};

function makeFiles(count: number): File[] {
  return Array.from({ length: count }, (_, i) => new File(['x'], `photo-${i}.jpg`, { type: 'image/jpeg' }));
}

function galleryInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"][multiple]');
  if (!input) throw new Error('gallery file input not found');
  return input as HTMLInputElement;
}

describe('CameraCaptureModal bulk upload cap (SEC-W3)', () => {
  it('caps a bulk selection at MAX_BULK_UPLOAD_FILES and shows a truncation notice', async () => {
    const { container } = render(
      <CameraCaptureModal
        isOpen
        onClose={vi.fn()}
        currentGuest={mockGuest}
        quests={[]}
        onPhotoUploaded={vi.fn()}
      />
    );

    const input = galleryInput(container);
    fireEvent.change(input, { target: { files: makeFiles(16) } });

    await waitFor(() => {
      expect(screen.getByText(i18n.t('camera.bulk_limit_notice', { selected: 16, max: 10 }))).toBeTruthy();
    });

    // The upload button label mirrors bulkFiles.length directly - proves the
    // stored selection was actually truncated, not just the notice text.
    await waitFor(() => {
      expect(screen.getByText(i18n.t('camera.upload_count', { count: 10 }))).toBeTruthy();
    });
  });

  it('does not show a truncation notice for a selection within the cap', async () => {
    const { container } = render(
      <CameraCaptureModal
        isOpen
        onClose={vi.fn()}
        currentGuest={mockGuest}
        quests={[]}
        onPhotoUploaded={vi.fn()}
      />
    );

    const input = galleryInput(container);
    fireEvent.change(input, { target: { files: makeFiles(3) } });

    await waitFor(() => {
      expect(screen.getByText(i18n.t('camera.upload_count', { count: 3 }))).toBeTruthy();
    });

    expect(screen.queryByText(i18n.t('camera.bulk_limit_notice', { selected: 3, max: 10 }))).toBeNull();
  });
});
