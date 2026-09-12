import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

import { PhotographerIngestPortal } from '../../src/components/ingest/PhotographerIngestPortal';
import { ingestApi } from '../../src/api/ingestApi';
import { WeddingEvent, Photo } from '../../src/types';
import { i18n } from '../../src/i18n';

// G1 (OPEN_ITEMS.md) — paid feature, used by external users (photographers)
// often on unfamiliar venue Wi-Fi; a silent failure here loses their shoot.

const EVENT: WeddingEvent = {
  id: 'e1',
  slug: 'monika-and-alexander-2026',
  title: 'Monika & Alexander',
  hostName: 'Monika & Alexander',
  hostEmail: 'host@example.com',
  eventDate: new Date().toISOString(),
  venueName: 'Villa',
  coverImageUrl: 'https://cdn.example/cover.jpg',
  themePalette: 'champagne_gold',
  welcomeMessage: 'Welcome!',
  planTier: 'celebration_pass',
  isModerationEnabled: false,
  isDisposableMode: false,
  isPublic: false,
  revealAt: null,
  maxPhotosPerGuest: 50,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeImageFiles(count: number): File[] {
  return Array.from({ length: count }, (_, i) => new File(['x'], `frame-${i}.jpg`, { type: 'image/jpeg' }));
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('PhotographerIngestPortal', () => {
  it('pre-fills the ingest key from the URL fragment, never the query string alone', () => {
    window.location.hash = '#key=wmi_from_fragment';
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);

    expect(screen.getByPlaceholderText('wmi_...')).toHaveValue('wmi_from_fragment');
  });

  it('rejects non-image files dropped into the picker', () => {
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);
    const pdf = new File(['x'], 'not-a-photo.pdf', { type: 'application/pdf' });
    const jpg = new File(['x'], 'real.jpg', { type: 'image/jpeg' });

    fireEvent.change(fileInput(), { target: { files: [pdf, jpg] } });

    expect(screen.getByText('1 image selected')).toBeInTheDocument();
    expect(screen.queryByText('not-a-photo.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('real.jpg')).toBeInTheDocument();
  });

  it('refuses to upload without an ingest key', () => {
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: makeImageFiles(2) } });

    fireEvent.click(screen.getByText(/Upload 2 to live screen/));

    expect(screen.getByText(i18n.t('ingest.portal_need_key'))).toBeInTheDocument();
  });

  it('refuses to upload with a key but no files selected', () => {
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('wmi_...'), { target: { value: 'wmi_test_key' } });

    fireEvent.click(screen.getByText(/Upload\s*to live screen/));

    expect(screen.getByText(i18n.t('ingest.portal_need_files'))).toBeInTheDocument();
  });

  it('uploads selected files with the trimmed key/name/caption and reports success', async () => {
    const uploadSpy = vi.spyOn(ingestApi, 'uploadPhotos').mockResolvedValue([{ id: 'p1' } as Photo, { id: 'p2' } as Photo]);
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('wmi_...'), { target: { value: '  wmi_test_key  ' } });
    fireEvent.change(screen.getByDisplayValue(i18n.t('ingest.default_label')), { target: { value: '  Studio X  ' } });
    fireEvent.change(fileInput(), { target: { files: makeImageFiles(2) } });

    fireEvent.click(screen.getByText(/Upload 2 to live screen/));

    await waitFor(() => expect(screen.getByText(/2 photos sent to the live screen\./)).toBeInTheDocument());

    expect(uploadSpy).toHaveBeenCalledWith(
      'e1',
      'wmi_test_key',
      expect.arrayContaining([expect.any(File)]),
      expect.objectContaining({ photographerName: 'Studio X', concurrency: 4 })
    );
    // The selected-files list clears after a successful send.
    expect(screen.queryByText(/image.*selected/)).not.toBeInTheDocument();
  });

  it('shows the server error message when the upload fails', async () => {
    vi.spyOn(ingestApi, 'uploadPhotos').mockRejectedValue(new Error('Ingest key revoked'));
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('wmi_...'), { target: { value: 'wmi_test_key' } });
    fireEvent.change(fileInput(), { target: { files: makeImageFiles(1) } });
    fireEvent.click(screen.getByText(/Upload 1 to live screen/));

    await waitFor(() => expect(screen.getByText('Ingest key revoked')).toBeInTheDocument());
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<PhotographerIngestPortal event={EVENT} onClose={onClose} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons.find((b) => b.querySelector('svg.lucide-x'))!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
