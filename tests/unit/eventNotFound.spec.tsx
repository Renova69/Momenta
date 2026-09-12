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
});
