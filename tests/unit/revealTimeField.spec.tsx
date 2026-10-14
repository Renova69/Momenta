import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import React from 'react';
import { RevealTimeField } from '../../src/components/host/dashboard/RevealTimeField';
import { i18n } from '../../src/i18n';

/**
 * N-109 — the host never saw, and could not change, when a disposable album
 * reveals. The toggle promised "the morning after"; nothing set a time at all.
 * The server now sets that morning, and this shows it and lets the host move it.
 */

afterEach(() => cleanup());

const dateField = () => screen.getByLabelText(i18n.t('host.reveal_date_field')) as HTMLInputElement;
const timeField = () => screen.getByLabelText(i18n.t('host.reveal_time_field')) as HTMLInputElement;

describe('the reveal time under disposable mode (N-109)', () => {
  it('shows the reveal the server set, in this device’s time', () => {
    const reveal = new Date(2027, 5, 13, 9, 0).toISOString();
    render(<RevealTimeField revealAt={reveal} onCommit={vi.fn()} />);

    expect(dateField().value).toBe('13.06.2027');
    expect(timeField().value).toBe('09:00');
  });

  it('saves a new reveal when the host leaves the field', () => {
    const onCommit = vi.fn();
    render(<RevealTimeField revealAt={new Date(2027, 5, 13, 9, 0).toISOString()} onCommit={onCommit} />);

    fireEvent.change(timeField(), { target: { value: '1130' } });
    fireEvent.blur(timeField());

    expect(onCommit).toHaveBeenCalledWith(new Date(2027, 5, 13, 11, 30).toISOString());
  });

  it('saves nothing for an unfinished or unchanged time', () => {
    const onCommit = vi.fn();
    render(<RevealTimeField revealAt={new Date(2027, 5, 13, 9, 0).toISOString()} onCommit={onCommit} />);

    fireEvent.blur(timeField());
    fireEvent.change(timeField(), { target: { value: '11' } });
    fireEvent.blur(timeField());

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('says it is being set while the server has not answered yet', () => {
    render(<RevealTimeField revealAt={null} onCommit={vi.fn()} />);

    expect(screen.getByText(i18n.t('host.reveal_pending'))).toBeTruthy();
  });
});
