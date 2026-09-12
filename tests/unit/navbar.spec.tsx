import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { Navbar } from '../../src/components/layout/Navbar';
import { Guest, HostUser } from '../../src/types';
import { i18n } from '../../src/i18n';
import { THEMES } from '../../src/config/themes';

const GUEST: Guest = { id: 'g1', eventId: 'e1', name: 'Silvia', createdAt: new Date().toISOString() };
const ANONYMOUS: Guest = { ...GUEST, id: 'anonymous', name: 'Guest' };
const HOST_USER: HostUser = {
  id: 'u1',
  email: 'host@example.com',
  fullName: 'Monika Petrova',
  role: 'couple',
  createdAt: new Date().toISOString(),
};

function baseProps(overrides: Partial<React.ComponentProps<typeof Navbar>> = {}) {
  return {
    activeView: 'guest' as const,
    setActiveView: vi.fn(),
    currentTheme: 'champagne_gold' as const,
    onThemeChange: vi.fn(),
    currentGuest: GUEST,
    onOpenGuestProfile: vi.fn(),
    onOpenPricing: vi.fn(),
    onOpenEventsList: vi.fn(),
    ...overrides,
  };
}

const originalLanguage = i18n.getLanguage();

beforeEach(() => {
  i18n.setLanguage(originalLanguage);
});

afterEach(() => {
  cleanup();
  i18n.setLanguage(originalLanguage);
});

describe('Navbar', () => {
  it('switches to the guest and host tabs', () => {
    const setActiveView = vi.fn();
    render(<Navbar {...baseProps({ setActiveView })} />);

    fireEvent.click(screen.getByText(i18n.t('nav.host_studio')));
    expect(setActiveView).toHaveBeenCalledWith('host');

    fireEvent.click(screen.getByText(i18n.t('nav.guest_app')));
    expect(setActiveView).toHaveBeenCalledWith('guest');
  });

  it('routes to pricing instead of the projector when live TV is locked on the free tier', () => {
    const setActiveView = vi.fn();
    const onOpenPricing = vi.fn();
    render(<Navbar {...baseProps({ setActiveView, onOpenPricing, currentPlanTier: 'free' })} />);

    fireEvent.click(screen.getByText(i18n.t('nav.live_tv')));

    expect(onOpenPricing).toHaveBeenCalledTimes(1);
    expect(setActiveView).not.toHaveBeenCalledWith('projector');
  });

  it('opens the projector directly once live TV is unlocked', () => {
    const setActiveView = vi.fn();
    const onOpenPricing = vi.fn();
    render(<Navbar {...baseProps({ setActiveView, onOpenPricing, currentPlanTier: 'celebration_pass' })} />);

    fireEvent.click(screen.getByText(i18n.t('nav.live_tv')));

    expect(setActiveView).toHaveBeenCalledWith('projector');
    expect(onOpenPricing).not.toHaveBeenCalled();
  });

  it('hides the live TV tab entirely on the home page', () => {
    render(<Navbar {...baseProps({ isHomePage: true })} />);
    expect(screen.queryByText(i18n.t('nav.live_tv'))).not.toBeInTheDocument();
  });

  it('shows the pending-review badge on the host tab', () => {
    render(<Navbar {...baseProps({ pendingCount: 3 })} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('lets a host pick a different theme from the palette dropdown', () => {
    const onThemeChange = vi.fn();
    render(<Navbar {...baseProps({ onThemeChange })} />);

    fireEvent.click(screen.getByTitle(i18n.t('nav.theme')));
    fireEvent.click(screen.getByText(i18n.t(THEMES.rose_blush.name)));

    expect(onThemeChange).toHaveBeenCalledWith('rose_blush');
    // The dropdown closes after a selection.
    expect(screen.queryByText(i18n.t(THEMES.rose_blush.name))).not.toBeInTheDocument();
  });

  it('toggles the language between bg and en', () => {
    i18n.setLanguage('bg');
    render(<Navbar {...baseProps()} />);

    const langButton = screen.getByTitle(i18n.t('nav.language'));
    expect(langButton).toHaveTextContent('BG');

    fireEvent.click(langButton);
    expect(i18n.getLanguage()).toBe('en');
  });

  it('shows the events-list button only for a logged-in host, and calls onOpenEventsList', () => {
    const onOpenEventsList = vi.fn();
    const { rerender } = render(<Navbar {...baseProps({ onOpenEventsList, currentHostUser: null })} />);
    expect(screen.queryByTitle(i18n.t('nav.my_events'))).not.toBeInTheDocument();

    rerender(<Navbar {...baseProps({ onOpenEventsList, currentHostUser: HOST_USER })} />);
    fireEvent.click(screen.getByTitle(i18n.t('nav.my_events')));
    expect(onOpenEventsList).toHaveBeenCalledTimes(1);
  });

  it('hides the guest identity chip on the home page for an anonymous guest', () => {
    const { rerender } = render(<Navbar {...baseProps({ isHomePage: true, currentGuest: ANONYMOUS })} />);
    expect(screen.queryByText('Guest')).not.toBeInTheDocument();

    rerender(<Navbar {...baseProps({ isHomePage: true, currentGuest: GUEST })} />);
    expect(screen.getByText('Silvia')).toBeInTheDocument();
  });

  it('logs the host out from the mobile menu', () => {
    const onHostLogout = vi.fn();
    render(<Navbar {...baseProps({ currentHostUser: HOST_USER, onHostLogout })} />);

    fireEvent.click(screen.getByTitle(i18n.t('nav.more')));
    fireEvent.click(screen.getByText(new RegExp(i18n.t('nav.logout'))));

    expect(onHostLogout).toHaveBeenCalledTimes(1);
  });
});
