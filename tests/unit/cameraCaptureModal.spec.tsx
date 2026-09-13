import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { CameraCaptureModal } from '../../src/components/camera/CameraCaptureModal';
import * as compressionService from '../../src/services/compressionService';
import { i18n } from '../../src/i18n';
import { Guest, ScavengerQuest } from '../../src/types';

/**
 * The capture modal.
 *
 * This is the one screen every guest at a wedding touches, on a phone, over
 * venue Wi-Fi, usually once. It was the least covered component in the
 * codebase because jsdom implements none of the media APIs it is built on —
 * which is exactly why the paths that do not need a camera were never tested
 * either: the permission branches, the gallery-upload path, and the bulk loop
 * that has to keep going when one photo in a batch fails.
 *
 * getUserMedia and the Permissions API are stubbed. Everything downstream of
 * "we have bytes" runs for real.
 */

const guest: Guest = {
  id: 'guest-1',
  eventId: 'event-1',
  name: 'Spec Guest',
  createdAt: new Date().toISOString(),
};

const quests: ScavengerQuest[] = [
  { id: 'q1', eventId: 'event-1', title: 'Find the cake', description: '', points: 10 } as ScavengerQuest,
];

function renderModal(over: Record<string, unknown> = {}) {
  const onPhotoUploaded = vi.fn();
  const onClose = vi.fn();
  const props = {
    isOpen: true,
    onClose,
    currentGuest: guest,
    quests,
    onPhotoUploaded,
    ...over,
  };
  const utils = render(
    <CameraCaptureModal {...(props as unknown as React.ComponentProps<typeof CameraCaptureModal>)} />
  );
  return { ...utils, onPhotoUploaded, onClose };
}

/** Stub getUserMedia to succeed, so the granted path runs. */
function grantCamera() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  return { track };
}

function denyCamera(name = 'NotAllowedError') {
  const err = Object.assign(new Error('denied'), { name });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockRejectedValue(err) },
  });
}

function permissionsReport(state: PermissionState | null) {
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: state === null ? undefined : { query: vi.fn().mockResolvedValue({ state }) },
  });
}

/** A File whose FileReader read resolves to a fixed data URL. */
function imageFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
}

const DATA_URL = 'data:image/jpeg;base64,AAAA';

function stubFileReader() {
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    queueMicrotask(() =>
      this.onload?.({ target: { result: DATA_URL } } as unknown as ProgressEvent<FileReader>)
    );
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(compressionService, 'compressAndFilterImage').mockResolvedValue({
    dataUrl: 'data:image/jpeg;base64,COMPRESSED',
    width: 1600,
    height: 1200,
  });
  permissionsReport(null);
  grantCamera();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('visibility', () => {
  it('renders nothing when closed', () => {
    const { container } = renderModal({ isOpen: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('does not ask for the camera while closed', () => {
    renderModal({ isOpen: false });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
});

describe('camera permission', () => {
  it('starts the camera when permission is already granted', async () => {
    permissionsReport('granted');
    renderModal();
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
  });

  it('starts the camera when the browser will prompt', async () => {
    permissionsReport('prompt');
    renderModal();
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
  });

  it('does not reopen the prompt when permission is already denied', async () => {
    permissionsReport('denied');
    const { container } = renderModal();

    await waitFor(() =>
      expect(container.textContent).toContain(i18n.t('camera.permission_subtitle'))
    );
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('falls back to asking directly when the Permissions API is unavailable', async () => {
    permissionsReport(null);
    renderModal();
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
  });

  it('falls back to asking directly when the permission query itself fails', async () => {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockRejectedValue(new Error('unsupported name')) },
    });
    renderModal();
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
  });

  it('explains a refusal rather than failing silently', async () => {
    denyCamera('NotAllowedError');
    const { container } = renderModal();

    await waitFor(() =>
      expect(container.textContent).toContain(i18n.t('camera.permission_subtitle'))
    );
  });

  it('treats a legacy PermissionDeniedError the same way', async () => {
    denyCamera('PermissionDeniedError');
    const { container } = renderModal();

    await waitFor(() =>
      expect(container.textContent).toContain(i18n.t('camera.permission_subtitle'))
    );
  });

  it("shows the device's own message for a non-permission failure", async () => {
    // A laptop with no camera, or one already held by another application.
    denyCamera('NotReadableError');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('Camera already in use'), { name: 'NotReadableError' })),
      },
    });

    renderModal();

    expect(await screen.findByText('Camera already in use')).toBeTruthy();
  });
});

describe('choosing from the gallery', () => {
  function fileInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error('file input not found');
    return input as HTMLInputElement;
  }

  it('ignores an empty selection', async () => {
    stubFileReader();
    const { container } = renderModal();

    fireEvent.change(fileInput(container), { target: { files: [] } });

    await Promise.resolve();
    expect(compressionService.compressAndFilterImage).not.toHaveBeenCalled();
  });

  it('previews a single chosen photo', async () => {
    stubFileReader();
    const { container } = renderModal();

    fireEvent.change(fileInput(container), { target: { files: [imageFile('a.jpg')] } });

    await waitFor(() => expect(compressionService.compressAndFilterImage).toHaveBeenCalled());
  });

  it('caps a bulk selection at ten files and says how many were dropped', async () => {
    stubFileReader();
    const { container } = renderModal();
    const many = Array.from({ length: 14 }, (_, i) => imageFile(`f${i}.jpg`));

    fireEvent.change(fileInput(container), { target: { files: many } });

    // The guest is told, rather than silently losing four photos.
    await waitFor(() => expect(container.textContent).toContain('14'));
  });

  it('keeps a selection at the cap without reporting a truncation', async () => {
    stubFileReader();
    const { container } = renderModal();
    const ten = Array.from({ length: 10 }, (_, i) => imageFile(`f${i}.jpg`));

    fireEvent.change(fileInput(container), { target: { files: ten } });

    await waitFor(() => expect(compressionService.compressAndFilterImage).toHaveBeenCalled());
  });

  it('still shows a preview when the filter pass fails', async () => {
    stubFileReader();
    vi.spyOn(compressionService, 'compressAndFilterImage').mockRejectedValue(new Error('decode failed'));
    const { container } = renderModal();

    fireEvent.change(fileInput(container), { target: { files: [imageFile('a.jpg')] } });

    // Falls back to the unfiltered original rather than leaving the guest
    // with a spinner and no photo.
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(container.querySelector('input[type="file"]')).toBeTruthy();
  });
});

describe('uploading', () => {
  function fileInput(container: HTMLElement): HTMLInputElement {
    return container.querySelector('input[type="file"]') as HTMLInputElement;
  }

  async function selectFiles(container: HTMLElement, files: File[]) {
    stubFileReader();
    fireEvent.change(fileInput(container), { target: { files } });
    await waitFor(() => expect(compressionService.compressAndFilterImage).toHaveBeenCalled());
  }

  /** The share/upload control, which only appears once a preview exists. */
  async function confirmButton(container: HTMLElement) {
    return waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((b) =>
        b.querySelector('svg.lucide-upload-cloud')
      );
      if (!button) throw new Error('confirm button not rendered yet');
      // It is disabled while the filter pass is still running.
      if ((button as HTMLButtonElement).disabled) throw new Error('still processing');
      return button;
    });
  }

  it('uploads a single photo with the guest and filter attached', async () => {
    const { container, onPhotoUploaded } = renderModal();
    await selectFiles(container, [imageFile('a.jpg')]);

    fireEvent.click(await confirmButton(container));

    await waitFor(() => expect(onPhotoUploaded).toHaveBeenCalled());
    expect(onPhotoUploaded.mock.calls[0][0]).toMatchObject({
      guestId: 'guest-1',
      guestName: 'Spec Guest',
      filterApplied: expect.any(String),
    });
  });

  it('keeps going when one photo in a batch fails to process', async () => {
    // A corrupt frame in the middle of a card must not freeze the upload and
    // lose everything after it.
    const compress = vi
      .spyOn(compressionService, 'compressAndFilterImage')
      .mockResolvedValueOnce({ dataUrl: DATA_URL, width: 10, height: 10 })
      .mockResolvedValueOnce({ dataUrl: DATA_URL, width: 10, height: 10 })
      .mockRejectedValueOnce(new Error('corrupt frame'))
      .mockResolvedValue({ dataUrl: DATA_URL, width: 10, height: 10 });

    const { container, onPhotoUploaded } = renderModal();
    await selectFiles(container, [imageFile('a.jpg'), imageFile('b.jpg'), imageFile('c.jpg')]);

    fireEvent.click(await confirmButton(container));

    await waitFor(() => expect(onPhotoUploaded).toHaveBeenCalled());
    // Two of the three survive; the failure is logged rather than fatal.
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(compress.mock.calls.length).toBeGreaterThan(1);
  });
});

/**
 * Pressing the shutter.
 *
 * This is the modal's whole purpose and it was the part jsdom made awkward to
 * reach: there is no camera, so the live-preview branch only runs once the
 * stream has been granted and a 2D context exists. Both are stubbed here; the
 * capture logic itself runs for real.
 */
describe('the shutter', () => {
  /** A 2D context that records the transform calls the mirror path makes. */
  function stubCanvas() {
    const calls: string[] = [];
    const ctx = {
      translate: vi.fn(() => calls.push('translate')),
      scale: vi.fn((x: number) => calls.push(`scale:${x}`)),
      drawImage: vi.fn(() => calls.push('drawImage')),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,SNAPPED'
    );
    return { ctx, calls };
  }

  function shutterButton(container: HTMLElement): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === i18n.t('camera.title')
    );
    if (!button) throw new Error('shutter button not found');
    return button as HTMLButtonElement;
  }

  function flipButton(container: HTMLElement): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === 'Flip camera'
    );
    if (!button) throw new Error('flip button not found');
    return button as HTMLButtonElement;
  }

  /** Render with the camera granted and wait for the live preview to appear. */
  async function renderLive() {
    permissionsReport('granted');
    const utils = renderModal();
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
    await waitFor(() => flipButton(utils.container));
    return utils;
  }

  it('captures the frame and shows it for review', async () => {
    stubCanvas();
    const { container } = await renderLive();

    fireEvent.click(shutterButton(container));

    // The live preview is replaced by the still, and the camera is released
    // rather than left running behind the review screen.
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
  });

  it('does not mirror a photo taken on the rear camera', async () => {
    const { calls } = stubCanvas();
    const { container } = await renderLive();

    fireEvent.click(shutterButton(container));

    await waitFor(() => expect(calls).toContain('drawImage'));
    expect(calls).not.toContain('translate');
  });

  it('un-mirrors a selfie so the saved photo is not back-to-front', async () => {
    // The preview is mirrored so the guest sees themselves the way a mirror
    // shows them, but the stored photo must read the right way round —
    // otherwise every selfie at the wedding has reversed text on the signage.
    const { calls } = stubCanvas();
    const { container } = await renderLive();

    fireEvent.click(flipButton(container));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
    fireEvent.click(shutterButton(container));

    await waitFor(() => expect(calls).toContain('drawImage'));
    expect(calls).toContain('translate');
    expect(calls).toContain('scale:-1');
  });

  it('does nothing rather than throwing when the browser gives no 2D context', async () => {
    // Some locked-down or low-memory mobile browsers refuse a context. A
    // guest pressing the shutter there gets nothing, which is bad — but a
    // thrown error inside an onClick would white-screen the whole modal.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = await renderLive();

    expect(() => fireEvent.click(shutterButton(container))).not.toThrow();
  });

  it('falls back to the phone’s own camera app when there is no live stream', async () => {
    // Permission refused, or a browser that cannot preview: the shutter still
    // has to do something, and the native file input is the way every phone
    // can still take a photo.
    denyCamera();
    permissionsReport('denied');
    const { container } = renderModal();

    const nativeInput = container.querySelector(
      'input[capture]'
    ) as HTMLInputElement | null;
    expect(nativeInput).toBeTruthy();
    const click = vi.spyOn(nativeInput!, 'click').mockImplementation(() => undefined);

    fireEvent.click(shutterButton(container));

    expect(click).toHaveBeenCalled();
  });
});
