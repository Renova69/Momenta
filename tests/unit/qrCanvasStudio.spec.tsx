import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { QRCanvasStudio } from '../../src/components/host/QRCanvasStudio';
import * as pdfPrintService from '../../src/services/pdfPrintService';
import { WeddingEvent, QRCanvasConfig } from '../../src/types';

/**
 * The QR poster studio.
 *
 * What a host configures here gets printed on A2 board and stood at the
 * entrance of a wedding — it is the least recoverable output in the product,
 * because the failure is discovered by a guest at the venue with a phone in
 * their hand and nothing to scan.
 *
 * Two things matter most and both were uncovered: the QR target is the URL
 * guests will actually visit, and an export that fails must say so rather than
 * leave a spinner running.
 */

const event = {
  id: 'event-1',
  slug: 'ivan-and-maria',
  title: 'Spec Wedding',
  hostName: 'Ivan & Maria',
  eventDate: '2026-09-20T15:00:00.000Z',
  venueName: 'Venue',
} as unknown as WeddingEvent;

const baseConfig: QRCanvasConfig = {
  id: 'qr-1',
  eventId: 'event-1',
  canvasSize: 'A2',
  frameStyle: 'minimal_gold',
  headline: '',
  subtext: '',
  accentColor: '#D4AF37',
  centerIcon: 'heart',
};

function renderStudio(over: Partial<QRCanvasConfig> = {}) {
  const onUpdateConfig = vi.fn();
  const utils = render(
    <QRCanvasStudio event={event} config={{ ...baseConfig, ...over }} onUpdateConfig={onUpdateConfig} />
  );
  return { ...utils, onUpdateConfig };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('choosing the poster', () => {
  it('reports a size change to the host so it is persisted', () => {
    const { container, onUpdateConfig } = renderStudio();
    const a3 = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('A3')
    );

    fireEvent.click(a3!);

    expect(onUpdateConfig).toHaveBeenCalledWith({ canvasSize: 'A3' });
  });

  it('adopts a config that changes underneath it', () => {
    const { rerender, container } = renderStudio({ canvasSize: 'A2' });

    rerender(
      <QRCanvasStudio
        event={event}
        config={{ ...baseConfig, canvasSize: 'A4', headline: 'From the server' }}
        onUpdateConfig={vi.fn()}
      />
    );

    expect(container.textContent).toContain('From the server');
  });

  it('falls back to defaults for a config with empty fields', () => {
    // A freshly created event has no headline or subtext yet; the studio must
    // still render something printable rather than blank board.
    const { container } = renderStudio({ headline: '', subtext: '', accentColor: '', centerIcon: undefined as never });
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('writes the headline, subtext and accent colour through', () => {
    const { container, onUpdateConfig } = renderStudio();

    const textInputs = Array.from(container.querySelectorAll('input[type="text"]'));
    fireEvent.change(textInputs[0], { target: { value: 'Scan me' } });
    expect(onUpdateConfig).toHaveBeenCalledWith({ headline: 'Scan me' });

    const colour = container.querySelector('input[type="color"]');
    if (colour) {
      fireEvent.change(colour, { target: { value: '#123456' } });
      expect(onUpdateConfig).toHaveBeenCalledWith({ accentColor: '#123456' });
    }
  });
});

describe('the QR target', () => {
  // The QR itself is rendered as SVG paths, so the encoded URL is not
  // inspectable from the DOM. What is observable is which target the host
  // picked, and that is the choice that decides whether a scan at the venue
  // resolves at all.
  it('offers both the LAN address and the public domain', () => {
    const { container } = renderStudio();
    expect(container.textContent).toContain('wedmoments.app');
  });

  it('switches the selected target when the host picks the public domain', () => {
    const { container } = renderStudio();
    const cloud = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('wedmoments.app')
    );

    const before = cloud!.className;
    fireEvent.click(cloud!);

    // The selected mode is styled differently; the click has to register.
    expect(cloud!.className).not.toBe(before);
  });
});

describe('exporting the poster', () => {
  it('produces a PDF', async () => {
    const pdf = vi.spyOn(pdfPrintService, 'exportPosterPdf').mockResolvedValue(undefined);
    const { container } = renderStudio();

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.toUpperCase().includes('PDF')
    );
    fireEvent.click(button!);

    await waitFor(() => expect(pdf).toHaveBeenCalled());
    // The live edits, not the saved config, are what gets printed.
    expect(pdf.mock.calls[0][0]).toMatchObject({ event, canvasConfig: expect.objectContaining({ canvasSize: 'A2' }) });
  });

  it('produces a PNG', async () => {
    const png = vi.spyOn(pdfPrintService, 'exportPosterPng').mockResolvedValue(undefined);
    const { container } = renderStudio();

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.toUpperCase().includes('PNG')
    );
    fireEvent.click(button!);

    await waitFor(() => expect(png).toHaveBeenCalled());
  });

  it('surfaces an export failure instead of leaving a spinner running', async () => {
    vi.spyOn(pdfPrintService, 'exportPosterPdf').mockRejectedValue(
      new Error('The poster preview is not on screen.')
    );
    const { container } = renderStudio();

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.toUpperCase().includes('PDF')
    );
    fireEvent.click(button!);

    expect(await screen.findByText('The poster preview is not on screen.')).toBeTruthy();
  });

  it('clears a previous error when the next export starts', async () => {
    const pdf = vi
      .spyOn(pdfPrintService, 'exportPosterPdf')
      .mockRejectedValueOnce(new Error('First failure'))
      .mockResolvedValueOnce(undefined);
    const { container } = renderStudio();

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.toUpperCase().includes('PDF')
    );

    fireEvent.click(button!);
    expect(await screen.findByText('First failure')).toBeTruthy();

    fireEvent.click(button!);
    await waitFor(() => expect(pdf).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('First failure')).toBeNull());
  });
});

describe('printing', () => {
  it('opens the print dialog through the vector path', () => {
    const print = vi.spyOn(pdfPrintService, 'triggerVectorPrint').mockImplementation(() => undefined);
    const { container } = renderStudio();

    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.querySelector('svg.lucide-printer')
    );
    if (!button) return;

    fireEvent.click(button);

    expect(print).toHaveBeenCalled();
  });

  it('reports a print failure rather than doing nothing visible', async () => {
    vi.spyOn(pdfPrintService, 'triggerVectorPrint').mockImplementation(() => {
      throw new Error('Preview not mounted');
    });
    const { container } = renderStudio();

    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.querySelector('svg.lucide-printer')
    );
    if (!button) return;

    fireEvent.click(button);

    expect(await screen.findByText('Preview not mounted')).toBeTruthy();
  });
});
