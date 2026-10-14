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

    // N-125 — this asserted the English "1 image selected" the portal showed
    // in a Bulgarian app; the test agreed with the bug.
    expect(screen.getByText(i18n.t('ingest.files_selected', { count: 1 }))).toBeInTheDocument();
    expect(screen.queryByText('not-a-photo.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('real.jpg')).toBeInTheDocument();
  });

  it('refuses to upload without an ingest key', () => {
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: makeImageFiles(2) } });

    fireEvent.click(screen.getByText(i18n.t('ingest.portal_upload_button', { count: 2 })));

    expect(screen.getByText(i18n.t('ingest.portal_need_key'))).toBeInTheDocument();
  });

  it('refuses to upload with a key but no files selected', () => {
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('wmi_...'), { target: { value: 'wmi_test_key' } });

    fireEvent.click(screen.getByText(i18n.t('ingest.portal_upload_none')));

    expect(screen.getByText(i18n.t('ingest.portal_need_files'))).toBeInTheDocument();
  });

  it('uploads selected files with the trimmed key/name/caption and reports success', async () => {
    const uploadSpy = vi
      .spyOn(ingestApi, 'uploadPhotos')
      .mockResolvedValue({ photos: [{ id: 'p1' } as Photo, { id: 'p2' } as Photo], failed: [] });
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('wmi_...'), { target: { value: '  wmi_test_key  ' } });
    fireEvent.change(screen.getByDisplayValue(i18n.t('ingest.default_label')), { target: { value: '  Studio X  ' } });
    fireEvent.change(fileInput(), { target: { files: makeImageFiles(2) } });

    fireEvent.click(screen.getByText(i18n.t('ingest.portal_upload_button', { count: 2 })));

    await waitFor(() => expect(screen.getByText(i18n.t('ingest.portal_sent', { count: 2 }))).toBeInTheDocument());

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
    fireEvent.click(screen.getByText(i18n.t('ingest.portal_upload_button', { count: 1 })));

    await waitFor(() => expect(screen.getByText('Ingest key revoked')).toBeInTheDocument());
  });

  it('keeps only the files that failed selected, so a retry sends just those (N-75)', async () => {
    const files = makeImageFiles(3);
    const uploadSpy = vi.spyOn(ingestApi, 'uploadPhotos').mockResolvedValueOnce({
      photos: [{ id: 'p1' } as Photo, { id: 'p2' } as Photo],
      failed: [{ file: files[1], reason: 'Not a supported image file' }],
    });
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('wmi_...'), { target: { value: 'wmi_test_key' } });
    fireEvent.change(fileInput(), { target: { files } });

    fireEvent.click(screen.getByText(i18n.t('ingest.portal_upload_button', { count: 3 })));

    await waitFor(() => expect(screen.getByText(i18n.t('ingest.portal_sent', { count: 2 }))).toBeInTheDocument());
    expect(
      screen.getByText(
        i18n.t('ingest.portal_some_failed', { count: 1, total: 3, reason: i18n.t('ingest.portal_upload_failed') })
      )
    ).toBeInTheDocument();

    uploadSpy.mockResolvedValueOnce({ photos: [{ id: 'p3' } as Photo], failed: [] });
    fireEvent.click(screen.getByText(i18n.t('ingest.portal_upload_button', { count: 1 })));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(2));
    expect(uploadSpy.mock.calls[1][2]).toEqual([files[1]]);
    // N-103 — the retry adds to what was already sent, rather than replacing it.
    await waitFor(() => expect(screen.getByText(i18n.t('ingest.portal_sent', { count: 3 }))).toBeInTheDocument());
  });

  it('says why a file was refused in the photographer\'s language, not the server\'s (N-105)', async () => {
    const files = makeImageFiles(1);
    vi.spyOn(ingestApi, 'uploadPhotos').mockResolvedValueOnce({
      photos: [],
      failed: [{ file: files[0], reason: 'Not a supported image file', code: 'NOT_AN_IMAGE', status: 400 }],
    });
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('wmi_...'), { target: { value: 'wmi_test_key' } });
    fireEvent.change(fileInput(), { target: { files } });

    fireEvent.click(screen.getByText(i18n.t('ingest.portal_upload_button', { count: 1 })));

    await waitFor(() =>
      expect(
        screen.getByText(
          i18n.t('ingest.portal_some_failed', { count: 1, total: 1, reason: i18n.t('ingest.reason_not_image') })
        )
      ).toBeInTheDocument()
    );
    expect(screen.queryByText(/Not a supported image file/)).toBeNull();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<PhotographerIngestPortal event={EVENT} onClose={onClose} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons.find((b) => b.querySelector('svg.lucide-x'))!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the portal in the app's language (N-125)", () => {
  it('signs the photos with a translated name when the photographer gives none', async () => {
    const upload = vi.spyOn(ingestApi, 'uploadPhotos').mockResolvedValue({ uploaded: 1, photos: [] } as never);
    window.location.hash = '#key=wmi_test';
    render(<PhotographerIngestPortal event={EVENT} onClose={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: makeImageFiles(1) } });
    // The name field starts filled; a photographer who clears it fell back to
    // the English "Official Photographer", shown on the wall under every frame.
    const nameField = screen.getByDisplayValue(i18n.t('ingest.default_label'));
    fireEvent.change(nameField, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: i18n.t('ingest.portal_upload_button', { count: 1 }) }));

    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload.mock.calls[0][3]).toMatchObject({ photographerName: i18n.t('ingest.default_label') });
    expect(JSON.stringify(upload.mock.calls[0])).not.toContain('Official Photographer');
    window.location.hash = '';
  });
});
