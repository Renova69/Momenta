import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { QRCanvasStudio } from '../../src/components/host/QRCanvasStudio';
import { ENV } from '../../src/config/env';
import { i18n } from '../../src/i18n';
import { WeddingEvent, QRCanvasConfig } from '../../src/types';

vi.mock('qrcode.react', () => ({
  QRCodeSVG: (props: { value: string }) => <svg data-testid="qr" data-value={props.value} />,
}));

/**
 * N-118 — where the printed QR code points.
 *
 * The "public domain" choice was hardcoded to https://wedmoments.app, which no
 * deployment configured, and the other choice was labelled with a developer's
 * LAN address (192.168.0.35:6500) on every deployment. The public address now
 * comes from VITE_PUBLIC_APP_URL; without one, the code points at this page's
 * own address, which in production is the album's real one.
 */

const event = { id: 'event-1', slug: 'ivan-and-maria', hostName: 'Ivan & Maria', eventDate: '2026-09-20T15:00:00.000Z', venueName: 'Venue' } as unknown as WeddingEvent;
const config: QRCanvasConfig = { id: 'qr-1', eventId: 'event-1', canvasSize: 'A2', frameStyle: 'minimal_gold', headline: '', subtext: '', accentColor: '#D4AF37', centerIcon: 'heart' };
const original = ENV.PUBLIC_APP_URL;

afterEach(() => {
  cleanup();
  ENV.PUBLIC_APP_URL = original;
});

const qrValue = () => screen.getAllByTestId('qr')[0].getAttribute('data-value');

describe('where the printed QR code points (N-118)', () => {
  it('points at this page\'s own address when no public address is configured', () => {
    ENV.PUBLIC_APP_URL = '';
    render(<QRCanvasStudio event={event} config={config} onUpdateConfig={vi.fn()} />);

    expect(qrValue()).toBe(`${window.location.origin}/e/ivan-and-maria`);
    expect(screen.queryByText(i18n.t('ui.q_r_canvas_studio.2'))).toBeNull();
    expect(document.body.textContent).not.toContain('192.168.0.35');
    expect(document.body.textContent).not.toContain('wedmoments.app');
  });

  it('offers the configured public address, labelled with real hosts', () => {
    ENV.PUBLIC_APP_URL = 'https://snimki.example.bg';
    render(<QRCanvasStudio event={event} config={config} onUpdateConfig={vi.fn()} />);

    expect(screen.getByText('snimki.example.bg')).toBeTruthy();
    expect(screen.getByText(window.location.host)).toBeTruthy();
    fireEvent.click(screen.getByText(i18n.t('ui.q_r_canvas_studio.2')));

    expect(qrValue()).toBe('https://snimki.example.bg/e/ivan-and-maria');
  });
});
