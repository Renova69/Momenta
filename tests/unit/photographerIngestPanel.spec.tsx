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

/**
 * What the key list draws when a field is absent.
 *
 * These rows are read by a host who is about to hand a credential to a
 * photographer they are paying, so a row that says "undefined" next to a key
 * is not a cosmetic problem — it is the moment they stop trusting the screen.
 */
describe('a key row with missing fields', () => {
  it('shows an ellipsis rather than nothing when the server sent no mask', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([
      keyInfo({ label: 'No Mask', masked: undefined }),
    ]);

    render(<PhotographerIngestPanel event={EVENT} />);

    await waitFor(() => expect(screen.getByText('No Mask')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('says nothing about last use for a key nobody has used yet', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([
      keyInfo({ label: 'Never Used', lastUsedAt: undefined }),
    ]);

    render(<PhotographerIngestPanel event={EVENT} />);

    await waitFor(() => expect(screen.getByText('Never Used')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain(i18n.t('ingest.last_used'));
  });

  it('shows when a key was last used once it has been', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([
      keyInfo({ label: 'In Use', lastUsedAt: '2026-02-03T10:00:00.000Z' }),
    ]);

    render(<PhotographerIngestPanel event={EVENT} />);

    await waitFor(() => expect(screen.getByText('In Use')).toBeInTheDocument());
    expect(document.body.textContent).toContain(i18n.t('ingest.last_used'));
  });

  it('tells the host the list is empty rather than leaving a blank panel', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([]);

    render(<PhotographerIngestPanel event={EVENT} />);

    await waitFor(() => expect(screen.getByText(i18n.t('ingest.no_keys'))).toBeInTheDocument());
  });
});

describe('when something fails', () => {
  it('reports a failed revoke instead of appearing to have worked', async () => {
    // The key stays live on the server. A host who believes they revoked it
    // has handed out a credential they think is dead.
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([keyInfo({ label: 'Studio X' })]);
    vi.spyOn(ingestApi, 'revokeKey').mockRejectedValue(new Error('Revoke failed upstream'));

    const { container } = render(<PhotographerIngestPanel event={EVENT} />);
    await waitFor(() => expect(screen.getByText('Studio X')).toBeInTheDocument());

    const revoke = Array.from(container.querySelectorAll('button')).find((b) =>
      b.querySelector('svg.lucide-trash-2')
    )!;
    fireEvent.click(revoke);

    await waitFor(() => expect(screen.getByText('Revoke failed upstream')).toBeInTheDocument());
  });

  it('still says something when the failure carries no message', async () => {
    // An Error with an empty message renders as a blank red box otherwise,
    // which reads as a rendering bug rather than as a failure.
    vi.spyOn(ingestApi, 'listKeys').mockRejectedValue(new Error(''));

    render(<PhotographerIngestPanel event={EVENT} />);

    await waitFor(() =>
      expect(screen.getByText(i18n.t('ingest.err_load'))).toBeInTheDocument()
    );
  });

  it('still says something when what was thrown is not an Error at all', async () => {
    vi.spyOn(ingestApi, 'listKeys').mockRejectedValue('a bare string');

    render(<PhotographerIngestPanel event={EVENT} />);

    await waitFor(() =>
      expect(screen.getByText(i18n.t('ingest.err_load'))).toBeInTheDocument()
    );
  });
});

describe('copying on a browser that will not allow it', () => {
  it('does not throw when the clipboard API is unavailable', async () => {
    // Clipboard access is blocked on a plain http:// origin, which is exactly
    // how this app is reached on a venue LAN.
    const clipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    vi.spyOn(ingestApi, 'listKeys').mockResolvedValue([]);

    const { container } = render(<PhotographerIngestPanel event={EVENT} />);
    await waitFor(() => expect(screen.getByText(i18n.t('ingest.no_keys'))).toBeInTheDocument());

    const copyButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.querySelector('svg.lucide-copy')
    );
    expect(() => copyButton && fireEvent.click(copyButton)).not.toThrow();

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  });
});
