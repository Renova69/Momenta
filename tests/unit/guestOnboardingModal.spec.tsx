import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

import { GuestOnboardingModal } from '../../src/components/guest/GuestOnboardingModal';
import * as compressionService from '../../src/services/compressionService';
import { Guest } from '../../src/types';
import { i18n } from '../../src/i18n';

// G1 (OPEN_ITEMS.md) — the first thing a guest sees; a broken save here means
// every like/comment/upload that follows attributes to the wrong identity.

const RETURNING_GUEST: Guest = {
  id: 'g1',
  eventId: 'e1',
  name: 'Silvia',
  tableNumber: 'Table 4',
  avatarUrl: 'https://cdn.example/avatar.jpg',
  createdAt: new Date().toISOString(),
};

const ANONYMOUS_GUEST: Guest = { ...RETURNING_GUEST, id: 'anonymous' };

function nameInput(): HTMLInputElement {
  return screen.getByPlaceholderText(i18n.t('profile.name_placeholder'));
}

function fileInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[type="file"]'));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GuestOnboardingModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <GuestOnboardingModal isOpen={false} onClose={vi.fn()} currentGuest={null} onSaveGuest={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('pre-fills name, table, and avatar for a returning guest', () => {
    render(
      <GuestOnboardingModal isOpen onClose={vi.fn()} currentGuest={RETURNING_GUEST} onSaveGuest={vi.fn()} />
    );

    expect(nameInput()).toHaveValue('Silvia');
    expect(screen.getByPlaceholderText(i18n.t('profile.table_placeholder'))).toHaveValue('Table 4');
    // Translated since N-143; it was the English "Guest avatar" in every language.
    expect(screen.getByAltText(i18n.t('profile.selfie_alt'))).toHaveAttribute('src', 'https://cdn.example/avatar.jpg');
  });

  it('leaves fields blank for a fresh anonymous guest, not a leftover name', () => {
    render(
      <GuestOnboardingModal isOpen onClose={vi.fn()} currentGuest={ANONYMOUS_GUEST} onSaveGuest={vi.fn()} />
    );

    expect(nameInput()).toHaveValue('');
    expect(screen.getByPlaceholderText(i18n.t('profile.table_placeholder'))).toHaveValue('');
    expect(screen.queryByAltText(i18n.t('profile.selfie_alt'))).not.toBeInTheDocument();
  });

  it('saves the trimmed name/table/avatar and closes on submit', () => {
    const onSaveGuest = vi.fn();
    const onClose = vi.fn();
    render(
      <GuestOnboardingModal isOpen onClose={onClose} currentGuest={RETURNING_GUEST} onSaveGuest={onSaveGuest} />
    );

    fireEvent.change(nameInput(), { target: { value: '  Silvia Georgieva  ' } });
    fireEvent.click(screen.getByText(i18n.t('profile.save_btn')));

    expect(onSaveGuest).toHaveBeenCalledWith('Silvia Georgieva', 'Table 4', 'https://cdn.example/avatar.jpg');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses to save a blank name', () => {
    const onSaveGuest = vi.fn();
    const onClose = vi.fn();
    render(
      <GuestOnboardingModal isOpen onClose={onClose} currentGuest={ANONYMOUS_GUEST} onSaveGuest={onSaveGuest} />
    );

    fireEvent.click(screen.getByText(i18n.t('profile.save_btn')));

    expect(onSaveGuest).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('compresses a selected avatar photo and previews the result', async () => {
    vi.spyOn(compressionService, 'compressAndFilterImage').mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,compressed',
      width: 256,
      height: 256,
    });

    render(
      <GuestOnboardingModal isOpen onClose={vi.fn()} currentGuest={ANONYMOUS_GUEST} onSaveGuest={vi.fn()} />
    );

    const file = new File(['selfie-bytes'], 'selfie.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInputs()[1], { target: { files: [file] } }); // gallery input

    await waitFor(() => expect(screen.getByAltText(i18n.t('profile.selfie_alt'))).toHaveAttribute('src', 'data:image/jpeg;base64,compressed'));
  });

  it('falls back to a raw data URL if compression fails', async () => {
    vi.spyOn(compressionService, 'compressAndFilterImage').mockRejectedValue(new Error('decode failed'));

    render(
      <GuestOnboardingModal isOpen onClose={vi.fn()} currentGuest={ANONYMOUS_GUEST} onSaveGuest={vi.fn()} />
    );

    const file = new File(['selfie-bytes'], 'selfie.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInputs()[0], { target: { files: [file] } }); // camera input

    await waitFor(() => expect(screen.getByAltText(i18n.t('profile.selfie_alt'))).toHaveAttribute('src', expect.stringMatching(/^data:/)));
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<GuestOnboardingModal isOpen onClose={onClose} currentGuest={ANONYMOUS_GUEST} onSaveGuest={vi.fn()} />);

    // Asked for by key, not by the English word: the close button used to
    // carry a hardcoded aria-label="Close" while the rest of the app was in
    // Bulgarian, and this is the assertion that would have caught it.
    fireEvent.click(screen.getByLabelText(i18n.t('common.close')));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * N-165 — found by the browser tests on CI. App passes a stand-in guest it
 * builds afresh on every render, and the form re-synced whenever the object
 * changed: any re-render while it was open (the album's photos arriving, a
 * live update) wiped what the guest had typed. On venue Wi-Fi that is exactly
 * when guests are typing.
 */
describe('a guest typing while the app updates around them (N-165)', () => {
  it('keeps what they typed when the stand-in guest is rebuilt', () => {
    const props = { isOpen: true, onClose: vi.fn(), onSaveGuest: vi.fn() };
    const { rerender } = render(<GuestOnboardingModal {...props} currentGuest={{ ...ANONYMOUS_GUEST }} />);

    fireEvent.change(nameInput(), { target: { value: 'Мария' } });
    rerender(<GuestOnboardingModal {...props} currentGuest={{ ...ANONYMOUS_GUEST, createdAt: new Date().toISOString() }} />);

    expect(nameInput().value).toBe('Мария');
  });

  it('still starts empty each time it opens for someone new', () => {
    const props = { onClose: vi.fn(), onSaveGuest: vi.fn() };
    const { rerender } = render(<GuestOnboardingModal {...props} isOpen currentGuest={{ ...ANONYMOUS_GUEST }} />);
    fireEvent.change(nameInput(), { target: { value: 'Мария' } });

    rerender(<GuestOnboardingModal {...props} isOpen={false} currentGuest={{ ...ANONYMOUS_GUEST }} />);
    rerender(<GuestOnboardingModal {...props} isOpen currentGuest={{ ...ANONYMOUS_GUEST }} />);

    expect(nameInput().value).toBe('');
  });

  it('shows the returning guest’s details once they are known', () => {
    const props = { isOpen: true, onClose: vi.fn(), onSaveGuest: vi.fn() };
    const { rerender } = render(<GuestOnboardingModal {...props} currentGuest={{ ...ANONYMOUS_GUEST }} />);

    rerender(<GuestOnboardingModal {...props} currentGuest={RETURNING_GUEST} />);

    expect(nameInput().value).toBe('Silvia');
  });
});
