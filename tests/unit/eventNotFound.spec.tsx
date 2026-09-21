import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { EventNotFound } from '../../src/components/common/EventNotFound';
import { i18n } from '../../src/i18n';

afterEach(() => cleanup());

describe('EventNotFound', () => {
  it('shows the requested slug when one is given', () => {
    render(<EventNotFound slug="missing-wedding-2026" onGoHome={vi.fn()} onCreateEvent={vi.fn()} />);
    expect(screen.getByText('/e/missing-wedding-2026')).toBeInTheDocument();
  });

  it('shows a generic expired-link message when no slug is given', () => {
    render(<EventNotFound onGoHome={vi.fn()} onCreateEvent={vi.fn()} />);
    expect(screen.getByText(i18n.t('event.link_expired'))).toBeInTheDocument();
    expect(screen.queryByText(/^\/e\//)).not.toBeInTheDocument();
  });

  it('calls onGoHome and onCreateEvent from their respective buttons', () => {
    const onGoHome = vi.fn();
    const onCreateEvent = vi.fn();
    render(<EventNotFound onGoHome={onGoHome} onCreateEvent={onCreateEvent} />);

    fireEvent.click(screen.getByText(i18n.t('common.go_home')));
    expect(onGoHome).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText(i18n.t('common.create_new')));
    expect(onCreateEvent).toHaveBeenCalledTimes(1);
  });

  it('says the connection failed, not that the wedding is missing', () => {
    // A guest at a venue with weak wifi has a perfectly good QR code. Telling
    // them their wedding does not exist is both wrong and alarming.
    render(<EventNotFound slug="real-wedding-2026" reason="unreachable" onGoHome={vi.fn()} onCreateEvent={vi.fn()} />);

    expect(screen.getByText(i18n.t('event.unreachable_hint'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('event.not_found_at'))).not.toBeInTheDocument();
  });

  it('offers to try again when the server could not be reached', () => {
    const onRetry = vi.fn();
    render(
      <EventNotFound slug="real-wedding-2026" reason="unreachable" onRetry={onRetry} onGoHome={vi.fn()} onCreateEvent={vi.fn()} />
    );

    fireEvent.click(screen.getByText(i18n.t('event.try_again')));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry for an album that genuinely does not exist', () => {
    render(<EventNotFound slug="missing-wedding-2026" onRetry={vi.fn()} onGoHome={vi.fn()} onCreateEvent={vi.fn()} />);

    expect(screen.queryByText(i18n.t('event.try_again'))).not.toBeInTheDocument();
  });

  it('says so plainly when the couple deleted the album', () => {
    render(<EventNotFound slug="erased-wedding-2026" reason="deleted" onGoHome={vi.fn()} onCreateEvent={vi.fn()} />);

    expect(screen.getByText(i18n.t('event.deleted_hint'))).toBeInTheDocument();
  });
});
