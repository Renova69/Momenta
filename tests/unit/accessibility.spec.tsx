import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import React from 'react';
import axe from 'axe-core';

import { LightboxModal } from '../../src/components/gallery/LightboxModal';
import { GuestOnboardingModal } from '../../src/components/guest/GuestOnboardingModal';
import { HostProfileModal } from '../../src/components/host/HostProfileModal';
import { i18n } from '../../src/i18n';
import { Guest, HostUser, Photo } from '../../src/types';

/**
 * What a guest gets who cannot see the screen, or cannot use a mouse.
 *
 * Every overlay in this app was a `<div className="fixed inset-0">`: it looked
 * like a dialog and behaved like nothing. No role, so a screen reader read the
 * page behind it as if the overlay were not there; no Escape, so the lightbox
 * could be opened by keyboard and not closed; no focus handling, so Tab walked
 * out of the dialog into a page hidden under the backdrop. Labels sat above
 * their fields with nothing joining the two, so a field announced as "edit
 * text" and nothing more.
 *
 * These tests pin the parts a jsdom render can actually see: the role, the
 * accessible name, Escape, the label-to-field link, and an axe pass over the
 * rendered markup. Contrast, focus order across a real page and what a screen
 * reader says out loud still need a browser and a person.
 */

const PHOTO: Photo = {
  id: 'p1',
  eventId: 'e1',
  guestId: 'g1',
  guestName: 'Ana Petrova',
  fullUrl: 'https://cdn.example/p1.jpg',
  thumbnailUrl: 'https://cdn.example/p1-thumb.jpg',
  status: 'approved',
  likesCount: 2,
  commentsCount: 0,
  likedByGuestIds: [],
  comments: [],
  reactions: [],
  createdAt: new Date('2026-09-20T18:00:00Z').toISOString(),
} as unknown as Photo;

const GUEST: Guest = { id: 'g1', name: 'Ana', eventId: 'e1' } as unknown as Guest;
const HOST: HostUser = { id: 'h1', email: 'host@example.com', fullName: 'Monika' } as unknown as HostUser;

/** Fails with the rule ids and the offending markup, which is what one needs to fix it. */
async function expectNoViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    // Colour contrast needs real layout and real pixels; jsdom has neither,
    // and axe cannot answer it here either way.
    rules: { 'color-contrast': { enabled: false } },
  });
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
  expect(summary).toEqual([]);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the lightbox is a dialog', () => {
  const open = () =>
    render(
      <LightboxModal
        photo={PHOTO}
        onClose={vi.fn()}
        currentGuest={GUEST}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onAddComment={vi.fn()}
      />
    );

  it('announces itself as a dialog named after whose photo it is', () => {
    open();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Ana Petrova')).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('closes on Escape', () => {
    // It could be opened from the keyboard and not closed: the only way out
    // was a close button with no accessible name.
    const onClose = vi.fn();
    render(
      <LightboxModal
        photo={PHOTO}
        onClose={onClose}
        currentGuest={GUEST}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onAddComment={vi.fn()}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives the close button a name', () => {
    open();
    expect(screen.getByRole('button', { name: i18n.t('common.close') })).toBeTruthy();
  });

  it('wraps Tab from the last control back to the first', () => {
    // The page behind the backdrop is still rendered and still focusable, so
    // without this Tab walks out of the dialog into a page nobody can see.
    // Asserted as a wrap rather than "focus is still inside": jsdom does not
    // move focus on Tab by itself, so the weaker assertion would hold even
    // with the trap removed, and would be a test that cannot fail.
    open();
    const dialog = screen.getByRole('dialog');
    const focusable = within(dialog).getAllByRole('button');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('passes an axe pass', async () => {
    const { container } = open();
    await expectNoViolations(container);
  });
});

describe('the guest sign-in dialog', () => {
  const open = (onClose = vi.fn()) =>
    render(
      <GuestOnboardingModal isOpen onClose={onClose} currentGuest={null} onSaveGuest={vi.fn()} />
    );

  it('attaches each visible label to its field', () => {
    // A placeholder is not a label: it disappears the moment anything is
    // typed, and several screen readers never announce it at all.
    open();
    expect(screen.getByLabelText(i18n.t('profile.name_label'))).toBeTruthy();
    expect(screen.getByLabelText(i18n.t('profile.table_label'))).toBeTruthy();
  });

  it('is a named dialog that Escape closes', () => {
    const onClose = vi.fn();
    open(onClose);

    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into itself when it opens', () => {
    open();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('passes an axe pass', async () => {
    const { container } = open();
    await expectNoViolations(container);
  });
});

describe('the host profile dialog', () => {
  it('labels the name and email fields', () => {
    render(<HostProfileModal isOpen onClose={vi.fn()} hostUser={HOST} onSaveName={vi.fn()} />);

    expect(screen.getByLabelText(i18n.t('host_profile.name_label'))).toBeTruthy();
    expect(screen.getByLabelText(i18n.t('host_profile.email_label'))).toBeTruthy();
  });

  it('passes an axe pass', async () => {
    const { container } = render(
      <HostProfileModal isOpen onClose={vi.fn()} hostUser={HOST} onSaveName={vi.fn()} />
    );
    await expectNoViolations(container);
  });
});

describe('the page language', () => {
  it('follows the language the app is showing', () => {
    // index.html hardcodes lang="bg". Switching to English left it saying
    // Bulgarian, so a screen reader read English words with Bulgarian
    // pronunciation.
    const before = i18n.getLanguage();
    try {
      i18n.setLanguage('en');
      expect(document.documentElement.lang).toBe('en');
      i18n.setLanguage('bg');
      expect(document.documentElement.lang).toBe('bg');
    } finally {
      i18n.setLanguage(before);
    }
  });
});
