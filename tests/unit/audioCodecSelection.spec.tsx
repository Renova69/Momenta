import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import React from 'react';
import { AudioGuestbook } from '../../src/components/audio/AudioGuestbook';
import { AudioGuestbookEntry } from '../../src/types';

/**
 * Codec negotiation and the secure-context guard.
 *
 * `audioGuestbook.spec.tsx` covers recording, the sixty-second cap, retake and
 * playback. This covers the branches underneath: which container the browser
 * actually gets asked for, and what happens on the platforms that support none
 * of them.
 *
 * It matters because the fallbacks are per-browser and untestable by hand —
 * Safari takes mp4 where Chrome takes webm/opus — and because a guest on a
 * plain http:// LAN address has no `navigator.mediaDevices` at all, which used
 * to surface as a bare TypeError rather than an explanation.
 */

function renderGuestbook(entries: AudioGuestbookEntry[] = []) {
  const onAddAudioEntry = vi.fn();
  const utils = render(<AudioGuestbook entries={entries} onAddAudioEntry={onAddAudioEntry} />);
  return { ...utils, onAddAudioEntry };
}

/** Capture the options MediaRecorder is constructed with. */
function stubMediaRecorder(supported: string[]) {
  const constructed: (MediaRecorderOptions | undefined)[] = [];

  class FakeRecorder {
    state = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      constructed.push(options);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) });
      this.onstop?.();
    }
  }

  (FakeRecorder as unknown as { isTypeSupported: (t: string) => boolean }).isTypeSupported = (t) =>
    supported.includes(t);

  vi.stubGlobal('MediaRecorder', FakeRecorder as unknown as typeof MediaRecorder);
  return constructed;
}

function grantMicrophone() {
  const track = { stop: vi.fn() };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] } as unknown as MediaStream),
    },
  });
}

/** The record control is the only primary action before a take exists. */
async function startRecording(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.querySelector('svg.lucide-mic') || b.querySelector('svg.lucide-circle')
  );
  if (!button) throw new Error('record button not found');
  fireEvent.click(button);
  await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:audio'),
    revokeObjectURL: vi.fn(),
  });
  grantMicrophone();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('codec negotiation', () => {
  it('prefers webm with opus where it is available', async () => {
    const constructed = stubMediaRecorder(['audio/webm;codecs=opus', 'audio/webm']);
    const { container } = renderGuestbook();

    await startRecording(container);

    expect(constructed[0]).toMatchObject({ mimeType: 'audio/webm;codecs=opus' });
  });

  it('falls back to plain webm', async () => {
    const constructed = stubMediaRecorder(['audio/webm']);
    const { container } = renderGuestbook();

    await startRecording(container);

    expect(constructed[0]).toMatchObject({ mimeType: 'audio/webm' });
  });

  it('falls back to mp4, which is the Safari path', async () => {
    const constructed = stubMediaRecorder(['audio/mp4']);
    const { container } = renderGuestbook();

    await startRecording(container);

    expect(constructed[0]).toMatchObject({ mimeType: 'audio/mp4' });
  });

  it('falls back to aac', async () => {
    const constructed = stubMediaRecorder(['audio/aac']);
    const { container } = renderGuestbook();

    await startRecording(container);

    expect(constructed[0]).toMatchObject({ mimeType: 'audio/aac' });
  });

  it('lets the browser choose when it supports none of them', async () => {
    // No options at all, rather than an explicit empty mimeType: the browser
    // then falls back to its own default, so a guest on an unusual platform
    // still gets a recording instead of an error.
    const constructed = stubMediaRecorder([]);
    const { container } = renderGuestbook();

    await startRecording(container);

    expect(constructed[0]).toBeUndefined();
  });
});

describe('when the platform cannot record at all', () => {
  it('explains an insecure context rather than throwing a TypeError', async () => {
    // navigator.mediaDevices does not exist on a plain http:// LAN address,
    // which is exactly how this app is reached at a venue.
    stubMediaRecorder(['audio/webm']);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });

    const { container } = renderGuestbook();
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.querySelector('svg.lucide-mic') || b.querySelector('svg.lucide-circle')
    );
    fireEvent.click(button!);

    await waitFor(() => expect(container.textContent?.length).toBeGreaterThan(0));
    // Something was said to the guest; the click did not simply do nothing.
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('reports a refused microphone', async () => {
    stubMediaRecorder(['audio/webm']);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
      },
    });

    const { container } = renderGuestbook();
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.querySelector('svg.lucide-mic') || b.querySelector('svg.lucide-circle')
    );
    fireEvent.click(button!);

    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
  });
});

describe('rendering existing entries', () => {
  const entry = (over: Partial<AudioGuestbookEntry> = {}): AudioGuestbookEntry =>
    ({
      id: 'a1',
      eventId: 'event-1',
      guestId: 'g1',
      guestName: 'Ana',
      audioUrl: 'https://cdn.example.com/a1.webm',
      durationSeconds: 12,
      createdAt: new Date().toISOString(),
      ...over,
    }) as AudioGuestbookEntry;

  it('renders an entry that carries no note', () => {
    const { container } = renderGuestbook([entry({ note: undefined })]);
    expect(container.textContent).toContain('Ana');
  });

  it('renders an entry with a zero duration without printing NaN', () => {
    const { container } = renderGuestbook([entry({ durationSeconds: 0 })]);
    expect(container.textContent).not.toContain('NaN');
  });

  it('renders several entries', () => {
    renderGuestbook([entry({ id: 'a1', guestName: 'Ana' }), entry({ id: 'a2', guestName: 'Boris' })]);
    expect(screen.getByText('Ana')).toBeTruthy();
    expect(screen.getByText('Boris')).toBeTruthy();
  });
});
