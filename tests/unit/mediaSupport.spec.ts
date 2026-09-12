import { describe, it, expect, afterEach } from 'vitest';
import { checkMediaSupport, mediaBlockMessageKey } from '../../src/utils/mediaSupport';
import { TRANSLATIONS } from '../../src/i18n';

/**
 * Camera and microphone capture only exists in a secure context. A phone opening
 * the album over a LAN address (http://192.168.x.x) has no
 * navigator.mediaDevices at all, which is why capture "works on the laptop"
 * (localhost is exempt) and fails on a guest's phone.
 */

const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

function setContext(opts: { secure: boolean; hasApi: boolean }) {
  Object.defineProperty(window, 'isSecureContext', {
    value: opts.secure,
    configurable: true,
    writable: true,
  });

  Object.defineProperty(navigator, 'mediaDevices', {
    value: opts.hasApi ? { getUserMedia: () => Promise.resolve({}) } : undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(navigator, 'mediaDevices', originalDescriptor);
  }
});

describe('media capture support detection', () => {
  it('allows capture on a secure page that exposes the API', () => {
    setContext({ secure: true, hasApi: true });

    const support = checkMediaSupport();
    expect(support.available).toBe(true);
    expect(support.reason).toBe('ok');
  });

  it('blames the insecure origin when the page is plain HTTP on a LAN address', () => {
    // This is the real-world failure: guests scan a QR pointing at a LAN IP.
    setContext({ secure: false, hasApi: false });

    const support = checkMediaSupport();
    expect(support.available).toBe(false);
    expect(support.reason).toBe('insecure_context');
    // The origin is reported back so the message can name what to change.
    expect(support.origin).toBe(window.location.origin);
  });

  it('blames the browser when the page is secure but the API is missing', () => {
    setContext({ secure: true, hasApi: false });

    const support = checkMediaSupport();
    expect(support.available).toBe(false);
    expect(support.reason).toBe('unsupported_browser');
  });

  it('explains the https requirement in both languages', () => {
    const key = mediaBlockMessageKey('insecure_context');
    expect(key).toBe('media.insecure_context');

    // The message has to name the fix, not just report a failure.
    expect(TRANSLATIONS.bg[key]).toContain('https');
    expect(TRANSLATIONS.en[key]).toContain('https');
    // And it interpolates the offending origin so the host can see what to change.
    expect(TRANSLATIONS.bg[key]).toContain('{{origin}}');
    expect(TRANSLATIONS.en[key]).toContain('{{origin}}');
  });

  it('maps every block reason to a real translation key', () => {
    for (const reason of ['insecure_context', 'unsupported_browser', 'ok'] as const) {
      const key = mediaBlockMessageKey(reason);
      expect(TRANSLATIONS.bg[key]).toBeTruthy();
      expect(TRANSLATIONS.en[key]).toBeTruthy();
    }
  });
});
