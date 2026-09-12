import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';

import { AudioGuestbook } from '../../src/components/audio/AudioGuestbook';
import { AudioGuestbookEntry } from '../../src/types';
import { i18n } from '../../src/i18n';

// G1 (OPEN_ITEMS.md) — media permissions are easy to break silently; nothing
// caught this component's behavior before.

class MockMediaRecorder {
  static isTypeSupported = vi.fn().mockReturnValue(true);
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: unknown, public options?: { mimeType?: string }) {}
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

function entry(overrides: Partial<AudioGuestbookEntry> = {}): AudioGuestbookEntry {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    eventId: 'e1',
    guestId: 'g2',
    guestName: 'Martin',
    audioUrl: 'https://cdn.example/a.webm',
    durationSeconds: 12,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as AudioGuestbookEntry;
}

beforeEach(() => {
  Object.defineProperty(window, 'MediaRecorder', {
    value: MockMediaRecorder,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AudioGuestbook', () => {
  it('shows the empty state when there are no recordings yet', () => {
    render(<AudioGuestbook entries={[]} onAddAudioEntry={vi.fn()} />);
    expect(screen.getByText(new RegExp(i18n.t('audio.empty_title')))).toBeInTheDocument();
  });

  it('lists existing entries with guest name, note, and duration', () => {
    render(
      <AudioGuestbook
        entries={[entry({ guestName: 'Uncle Ivan', note: 'Congratulations!', durationSeconds: 65 })]}
       
        onAddAudioEntry={vi.fn()}
      />
    );

    expect(screen.getByText('Uncle Ivan')).toBeInTheDocument();
    expect(screen.getByText('"Congratulations!"')).toBeInTheDocument();
    expect(screen.getByText('1:05')).toBeInTheDocument();
  });

  it('records for 1:00 max, then lets the guest preview, add a note, and save it', async () => {
    vi.useFakeTimers();
    const onAddAudioEntry = vi.fn();
    render(<AudioGuestbook entries={[]} onAddAudioEntry={onAddAudioEntry} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('audio.record_btn') }));
      await Promise.resolve(); // flush the async getUserMedia().then(...) chain
    });

    expect(screen.getByText(i18n.t('audio.stop_btn'))).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText('0:03 / 1:00')).toBeInTheDocument();

    fireEvent.click(screen.getByText(i18n.t('audio.stop_btn')));

    // Preview/save form replaces the recorder.
    expect(screen.getByText(i18n.t('audio.save_btn'))).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(i18n.t('audio.note_placeholder')), {
      target: { value: 'With all our love' },
    });

    fireEvent.click(screen.getByText(i18n.t('audio.save_btn')));

    expect(onAddAudioEntry).toHaveBeenCalledTimes(1);
    const [blob, durationSeconds, note, mimeType] = onAddAudioEntry.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(durationSeconds).toBe(3);
    expect(note).toBe('With all our love');
    expect(mimeType).toBe('audio/webm;codecs=opus');

    // Back to the record view, ready for another message.
    expect(screen.getByRole('button', { name: i18n.t('audio.record_btn') })).toBeInTheDocument();
  });

  it('auto-stops recording at the 60-second cap', async () => {
    vi.useFakeTimers();
    render(<AudioGuestbook entries={[]} onAddAudioEntry={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('audio.record_btn') }));
      await Promise.resolve();
    });

    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    // Recording stopped on its own into the preview/save form — not stuck
    // mid-recording, and not silently discarded either.
    expect(screen.queryByText(i18n.t('audio.stop_btn'))).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('audio.save_btn'))).toBeInTheDocument();
  });

  it('discards the take on retake without calling onAddAudioEntry', async () => {
    const onAddAudioEntry = vi.fn();
    render(<AudioGuestbook entries={[]} onAddAudioEntry={onAddAudioEntry} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('audio.record_btn') }));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText(i18n.t('audio.stop_btn')));
    expect(screen.getByText(i18n.t('audio.save_btn'))).toBeInTheDocument();

    fireEvent.click(screen.getByText(i18n.t('camera.retake')));

    expect(screen.getByRole('button', { name: i18n.t('audio.record_btn') })).toBeInTheDocument();
    expect(onAddAudioEntry).not.toHaveBeenCalled();
  });

  it('shows a permission-blocked message instead of crashing when the mic is unavailable', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });

    render(<AudioGuestbook entries={[]} onAddAudioEntry={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('audio.record_btn') }));

    // Still on the record view (never entered the recording state), and some
    // block explanation is shown rather than an unhandled exception.
    expect(screen.getByRole('button', { name: i18n.t('audio.record_btn') })).toBeInTheDocument();
    expect(document.querySelector('.text-rosewood-200')).toBeTruthy();

    if (original) Object.defineProperty(navigator, 'mediaDevices', original);
  });

  it('toggles play/pause on an existing entry', () => {
    render(
      <AudioGuestbook entries={[entry({ id: 'a1', guestName: 'Martin' })]} onAddAudioEntry={vi.fn()} />
    );

    const playButtons = screen.getAllByRole('button');
    const entryPlayButton = playButtons.find((b) => b.className.includes('rounded-full') && b.className.includes('shrink-0'))!;

    fireEvent.click(entryPlayButton);
    expect(entryPlayButton.className).toContain('animate-pulse');

    fireEvent.click(entryPlayButton);
    expect(entryPlayButton.className).not.toContain('animate-pulse');
  });
});
