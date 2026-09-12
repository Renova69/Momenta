import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { BottomNav } from '../../src/components/layout/BottomNav';
import { i18n } from '../../src/i18n';

function baseProps(overrides: Partial<React.ComponentProps<typeof BottomNav>> = {}) {
  return {
    activeView: 'guest' as const,
    activeGuestTab: 'feed' as const,
    onSelectTab: vi.fn(),
    onSelectView: vi.fn(),
    onOpenCapture: vi.fn(),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('BottomNav', () => {
  it('switches to the guest view (if not already there) and selects the tapped tab', () => {
    const onSelectTab = vi.fn();
    const onSelectView = vi.fn();
    render(<BottomNav {...baseProps({ activeView: 'host', onSelectTab, onSelectView })} />);

    fireEvent.click(screen.getByText(i18n.t('feed.quests')));

    expect(onSelectView).toHaveBeenCalledWith('guest');
    expect(onSelectTab).toHaveBeenCalledWith('quests');
  });

  it('does not re-select the guest view when already on it', () => {
    const onSelectView = vi.fn();
    render(<BottomNav {...baseProps({ activeView: 'guest', onSelectView })} />);

    fireEvent.click(screen.getByText(i18n.t('feed.all_moments')));

    expect(onSelectView).not.toHaveBeenCalled();
  });

  it('opens the camera capture from the center shutter button', () => {
    const onOpenCapture = vi.fn();
    render(<BottomNav {...baseProps({ onOpenCapture })} />);

    fireEvent.click(screen.getByTitle(i18n.t('camera.title')));
    expect(onOpenCapture).toHaveBeenCalledTimes(1);
  });

  it('shows quest and audio badge counts only when there is something to show', () => {
    const { rerender } = render(<BottomNav {...baseProps({ questsCount: 0, audioCount: 0 })} />);
    expect(screen.queryByText('4')).not.toBeInTheDocument();

    rerender(<BottomNav {...baseProps({ questsCount: 4, audioCount: 2 })} />);
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('toggles between host studio and guest app on the last tab', () => {
    const onSelectView = vi.fn();
    const { rerender } = render(<BottomNav {...baseProps({ activeView: 'guest', onSelectView })} />);

    expect(screen.getByText(i18n.t('nav.host_studio'))).toBeInTheDocument();
    fireEvent.click(screen.getByText(i18n.t('nav.host_studio')));
    expect(onSelectView).toHaveBeenCalledWith('host');

    rerender(<BottomNav {...baseProps({ activeView: 'host', onSelectView })} />);
    expect(screen.getByText(i18n.t('nav.guest_app'))).toBeInTheDocument();
    fireEvent.click(screen.getByText(i18n.t('nav.guest_app')));
    expect(onSelectView).toHaveBeenCalledWith('guest');
  });

  it('shows the pending-review badge on the host tab', () => {
    render(<BottomNav {...baseProps({ pendingCount: 5 })} />);
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});
