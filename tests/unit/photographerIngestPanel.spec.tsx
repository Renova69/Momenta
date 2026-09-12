import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import React from 'react';

import { PhotographerIngestPanel } from '../../src/components/host/PhotographerIngestPanel';
import { ingestApi, IngestKeyInfo } from '../../src/api/ingestApi';
import { WeddingEvent } from '../../src/types';
import { i18n } from '../../src/i18n';

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

function keyInfo(overrides: Partial<IngestKeyInfo> = {}): IngestKeyInfo {
  return {
    id: `k-${Math.random().toString(36).slice(2, 8)}`,
    label: 'Studio X',
    createdAt: new Date().toISOString(),
    masked: 'wmi_****abcd',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('PhotographerIngestPanel', () => {
  it('loads and lists active keys, excluding revoked ones from the count', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([
      keyInfo({ label: 'Studio A' }),
      keyInfo({ label: 'Studio B (revoked)', revokedAt: new Date().toISOString() }),
    ]);

    render(<PhotographerIngestPanel event={EVENT} />);

    await waitFor(() => expect(screen.getByText('Studio A')).toBeInTheDocument());
    expect(screen.queryByText('Studio B (revoked)')).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('ingest.active_keys', { count: 1 }))).toBeInTheDocument();
  });

  it('shows a load error instead of a silent empty list', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockRejectedValue(new Error('Server unreachable'));
    render(<PhotographerIngestPanel event={EVENT} />);

    await waitFor(() => expect(screen.getByText('Server unreachable')).toBeInTheDocument());
  });

  it('generates a new key, shows the plaintext once, and refreshes the list', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([]);
    const createSpy = vi.spyOn(ingestApi, 'createKey').mockResolvedValue(
      keyInfo({ id: 'new-key', label: 'Studio X', key: 'wmi_plaintext_secret' })
    );

    render(<PhotographerIngestPanel event={EVENT} />);
    await waitFor(() => expect(ingestApi.listKeys).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText(i18n.t('ingest.key_label_placeholder')), { target: { value: 'Studio X' } });
    await act(async () => {
      fireEvent.click(screen.getByText(i18n.t('ingest.generate_key')));
      await Promise.resolve();
    });

    expect(createSpy).toHaveBeenCalledWith('e1', 'Studio X');
    // Shown twice by design: the one-time "copy now" block, and the FTP
    // integration instructions' password field.
    expect(screen.getAllByText('wmi_plaintext_secret').length).toBeGreaterThanOrEqual(1);
    // The portal link carries the key in the URL fragment, not the query string.
    expect(document.body.textContent).toMatch(/#key=wmi_plaintext_secret/);
    expect(ingestApi.listKeys).toHaveBeenCalledTimes(2);
  });

  it('shows the create error when key generation fails', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([]);
    vi.spyOn(ingestApi, 'createKey').mockRejectedValue(new Error('Quota reached'));

    render(<PhotographerIngestPanel event={EVENT} />);
    await waitFor(() => expect(ingestApi.listKeys).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByText(i18n.t('ingest.generate_key')));
      await Promise.resolve();
    });

    expect(screen.getByText('Quota reached')).toBeInTheDocument();
  });

  it('revokes a key and refreshes the list', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([keyInfo({ id: 'k1', label: 'Studio A' })]);
    const revokeSpy = vi.spyOn(ingestApi, 'revokeKey').mockResolvedValue({ success: true, keyId: 'k1' });

    render(<PhotographerIngestPanel event={EVENT} />);
    await waitFor(() => expect(screen.getByText('Studio A')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(document.querySelector('button:has(svg.lucide-trash-2)')!);
      await Promise.resolve();
    });

    expect(revokeSpy).toHaveBeenCalledWith('k1');
    expect(ingestApi.listKeys).toHaveBeenCalledTimes(2);
  });

  it('shows a copied confirmation that reverts after a moment', async () => {
    vi.useFakeTimers();
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([]);
    vi.spyOn(ingestApi, 'createKey').mockResolvedValue(keyInfo({ key: 'wmi_plaintext_secret' }));

    render(<PhotographerIngestPanel event={EVENT} />);

    await act(async () => {
      fireEvent.click(screen.getByText(i18n.t('ingest.generate_key')));
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText(i18n.t('ingest.copy')));
    expect(screen.getByText(i18n.t('ingest.copied'))).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText(i18n.t('ingest.copied'))).not.toBeInTheDocument();
  });
});
