import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import React from 'react';
import axe from 'axe-core';
import fs from 'fs';
import path from 'path';

import { LightboxModal } from '../../src/components/gallery/LightboxModal';
import { PhotoCard } from '../../src/components/gallery/PhotoCard';
import { GuestOnboardingModal } from '../../src/components/guest/GuestOnboardingModal';
import { HostProfileModal } from '../../src/components/host/HostProfileModal';
import { useDialog } from '../../src/hooks/useDialog';
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

  // N-147 — axe in a browser measured the empty-comments line at too little
  // contrast for its size; jsdom cannot measure it, so the class is pinned.
  it('writes "no comments yet" in a colour that can be read', () => {
    open();
    const line = screen.getByText(i18n.t('lightbox.no_comments'));
    expect(line.className).not.toMatch(/text-cream-400\/50/);
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

/**
 * N-140 — the trap counted controls that are not on screen, such as the
 * camera's file inputs, kept in the markup with display:none. Tab from the
 * last control a guest could see was then not "the last one", so the trap let
 * it through and focus fell out of the dialog onto the page.
 */
describe('the dialog focus trap', () => {
  function TwoButtonsAndAHiddenInput() {
    const { dialogRef, dialogProps } = useDialog({ onClose: () => undefined });
    return (
      <div ref={dialogRef} {...dialogProps}>
        <button type="button">First</button>
        <button type="button">Last one on screen</button>
        <input type="file" data-testid="hidden-input" />
      </div>
    );
  }

  it('wraps from the last control on screen, skipping ones that are not', () => {
    render(<TwoButtonsAndAHiddenInput />);
    // jsdom lays nothing out; say what a browser would about display:none.
    Object.assign(screen.getByTestId('hidden-input'), { checkVisibility: () => false });
    screen.getByRole('button', { name: 'Last one on screen' }).focus();

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });
});

/**
 * N-143 — every photo was announced as "Wedding moment", in English whatever
 * the page's language, and the same for every photo: a screen-reader user
 * walking the feed heard one phrase over and over.
 */
describe('a photo, read aloud', () => {
  const card = (photo: Photo) =>
    render(
      <PhotoCard
        photo={photo}
        currentGuest={GUEST}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onOpenComments={vi.fn()}
        onOpenLightbox={vi.fn()}
      />
    );
  const lightbox = (photo: Photo) =>
    render(
      <LightboxModal photo={photo} onClose={vi.fn()} currentGuest={GUEST} onLike={vi.fn()} onReact={vi.fn()} onAddComment={vi.fn()} />
    );
  const byAna = i18n.t('photo.alt_by', { name: 'Ana Petrova' });

  it('is named by who took it, in the feed and full screen', () => {
    card({ ...PHOTO, caption: undefined } as Photo);
    expect(screen.getByRole('img', { name: byAna })).toBeTruthy();
    cleanup();

    lightbox({ ...PHOTO, caption: undefined } as Photo);
    expect(screen.getByRole('img', { name: byAna })).toBeTruthy();
  });

  it('is named by its caption when it has one', () => {
    card({ ...PHOTO, caption: 'Първият танц' } as Photo);
    expect(screen.getByRole('img', { name: 'Първият танц' })).toBeTruthy();
  });
});

/**
 * N-144 — a reaction button was named by its emoji alone, so what a screen
 * reader said depended on its own emoji vocabulary, and nothing said whether
 * the guest had already given that reaction.
 */
describe('reactions, read aloud', () => {
  const reacted = { ...PHOTO, reactions: [{ reaction: 'heart', guestId: GUEST.id }] } as Photo;
  const heart = () => screen.getByRole('button', { name: new RegExp(`^${i18n.t('reaction.heart')}`) });
  const clap = () => screen.getByRole('button', { name: new RegExp(`^${i18n.t('reaction.clap')}`) });

  it('names each one in words, and says which the guest has given, on a card', () => {
    render(
      <PhotoCard photo={reacted} currentGuest={GUEST} onLike={vi.fn()} onReact={vi.fn()} onOpenComments={vi.fn()} onOpenLightbox={vi.fn()} />
    );

    expect(heart()).toHaveAttribute('aria-pressed', 'true');
    expect(clap()).toHaveAttribute('aria-pressed', 'false');
  });

  it('does the same full screen', () => {
    render(
      <LightboxModal photo={reacted} onClose={vi.fn()} currentGuest={GUEST} onLike={vi.fn()} onReact={vi.fn()} onAddComment={vi.fn()} />
    );

    expect(heart()).toHaveAttribute('aria-pressed', 'true');
    expect(clap()).toHaveAttribute('aria-pressed', 'false');
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

  // N-122 — with the password and account section, and its delete panel open.
  it('passes an axe pass with the account section', async () => {
    const { container } = render(
      <HostProfileModal
        isOpen
        onClose={vi.fn()}
        hostUser={HOST}
        onSaveName={vi.fn()}
        onChangePassword={vi.fn()}
        onDeleteAccount={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: i18n.t('account.delete_title') }));
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

describe('the page shell', () => {
  it('lets a guest pinch to zoom', () => {
    // index.html carried `maximum-scale=1.0, user-scalable=no`, which is a
    // WCAG 1.4.4 failure and, on an album read one-handed in a dark room, the
    // setting that stopped the guest who most needed to zoom into a face.
    const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
    const viewport = html.match(/<meta name="viewport"[^>]*>/)?.[0] ?? '';

    expect(viewport).toContain('width=device-width');
    expect(viewport).not.toContain('user-scalable=no');
    expect(viewport).not.toMatch(/maximum-scale/);
  });
});
