import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { HostDashboard } from '../../src/components/host/HostDashboard';
import { eventsApi } from '../../src/api/eventsApi';
import { i18n } from '../../src/i18n';
import { WeddingEvent, QRCanvasConfig, PlanTier } from '../../src/types';

/**
 * The dashboard shell: tab routing, the tier gates, and the destructive
 * actions.
 *
 * After the split in REPO_AUDIT §13 this component owns the state and the
 * actions that change it, and renders the gates; each tab's markup lives in
 * `./dashboard/`. The gates are the part worth testing here — they decide what
 * a host on a given plan can even reach, and they are a UI affordance over a
 * server rule, so a gate that opens too far is a paid feature given away and a
 * gate that closes too far is a customer who paid and cannot use it.
 *
 * `hostDashboard.spec.tsx` covers FE-05 (the slug must survive a date change).
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(window, 'alert').mockImplementation(() => undefined);
});

const baseEvent: WeddingEvent = {
  id: 'event-1',
  slug: 'ivan-and-maria',
  title: 'Spec Wedding',
  hostName: 'Spec Host',
  hostEmail: 'host@example.com',
  eventDate: '2026-09-18T16:30:00.000Z',
  venueName: 'Venue',
  coverImageUrl: '',
  themePalette: 'champagne_gold',
  welcomeMessage: 'Welcome',
  isModerationEnabled: false,
  isDisposableMode: false,
  isPublic: false,
  revealAt: null,
  maxPhotosPerGuest: 50,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const qrConfig: QRCanvasConfig = {
  id: 'qr-1',
  eventId: 'event-1',
  canvasSize: 'A2',
  frameStyle: 'minimal_gold',
  headline: '',
  subtext: '',
  accentColor: '#D4AF37',
  centerIcon: 'heart',
};

interface Overrides {
  planTier?: PlanTier;
  onOpenPricing?: () => void;
  onUpdateEvent?: () => void;
  onResetData?: () => void;
}

function renderDashboard(over: Overrides = {}) {
  const { planTier, ...rest } = over;
  const props = {
    event: { ...baseEvent, planTier } as WeddingEvent,
    guests: [],
    photos: [],
    quests: [],
    audioEntries: [],
    qrConfig,
    onUpdateEvent: vi.fn(),
    onUpdateQRConfig: vi.fn(),
    onSetPhotoStatus: vi.fn(),
    onDeletePhoto: vi.fn(),
    onAddQuest: vi.fn(),
    onResetData: vi.fn(),
    onOpenPricing: vi.fn(),
    ...rest,
  };
  const rendered = render(
    <HostDashboard {...(props as unknown as React.ComponentProps<typeof HostDashboard>)} />
  );
  return { props, ...rendered };
}

/** Switch tabs by clicking the nav button carrying this label. */
function openTab(container: HTMLElement, key: string) {
  const label = i18n.t(key);
  const button = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(label)
  );
  if (!button) throw new Error(`tab not found: ${label} (${key})`);
  fireEvent.click(button);
}

describe('tier gates', () => {
  const gated: [string, string][] = [
    ['moderation', 'host.moderation'],
    ['canvas', 'host.canvas_studio'],
    ['quests', 'host.quests_mgr'],
    ['export', 'host.export_zip'],
  ];

  /** The locked card always leads with the plan label; the tabs never do. */
  const LOCKED = () => i18n.t('gate.plan_label');

  it.each(gated)('locks the %s tab on the free plan', (_name, tabKey) => {
    const { container } = renderDashboard({ planTier: 'free' });

    openTab(container, tabKey);

    // The locked card offers the upgrade rather than the feature.
    expect(container.textContent).toContain(LOCKED());
  });

  it.each(gated)('unlocks the %s tab on pro_planner', (_name, tabKey) => {
    const { container } = renderDashboard({ planTier: 'pro_planner' });

    openTab(container, tabKey);

    expect(container.textContent).not.toContain(LOCKED());
  });

  it('treats an absent planTier as free, which fails closed', () => {
    const { container } = renderDashboard({ planTier: undefined });

    openTab(container, 'host.export_zip');

    expect(container.textContent).toContain(LOCKED());
  });

  it('never gates the overview tab', () => {
    const { container } = renderDashboard({ planTier: 'free' });
    expect(container.textContent).not.toContain(LOCKED());
  });

  it('never gates photographer ingest', () => {
    const { container } = renderDashboard({ planTier: 'free' });
    // This tab's label is literal, not an i18n key.
    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Photographer Ingest')
    );
    fireEvent.click(button!);
    expect(container.textContent).not.toContain(LOCKED());
  });

  it('offers the pricing modal from a locked tab', () => {
    const onOpenPricing = vi.fn();
    const { container } = renderDashboard({ planTier: 'free', onOpenPricing });

    openTab(container, 'host.quests_mgr');
    // The locked card's only button is the upgrade path.
    const cards = Array.from(container.querySelectorAll('button'));
    const cta = cards[cards.length - 1];
    fireEvent.click(cta);

    expect(onOpenPricing).toHaveBeenCalled();
  });
});

describe('revoking every guest session', () => {
  it('asks first, and does nothing when the host declines', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const reset = vi.spyOn(eventsApi, 'resetGuestSessions');
    const { container } = renderDashboard({ planTier: 'pro_planner' });

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(i18n.t('host.reset_guest_sessions'))
    );
    fireEvent.click(button!);

    expect(confirm).toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('reports how many sessions it actually ended', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(eventsApi, 'resetGuestSessions').mockResolvedValue({ guestsReset: 12 } as never);
    const { container } = renderDashboard({ planTier: 'pro_planner' });

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(i18n.t('host.reset_guest_sessions'))
    );
    fireEvent.click(button!);

    await waitFor(() =>
      expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('12'))
    );
  });

  it('surfaces a failure rather than pretending it worked', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(eventsApi, 'resetGuestSessions').mockRejectedValue(new Error('Server said no'));
    const { container } = renderDashboard({ planTier: 'pro_planner' });

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(i18n.t('host.reset_guest_sessions'))
    );
    fireEvent.click(button!);

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Server said no'));
  });
});

describe('deleting the album (D2)', () => {
  function deleteButton(container: HTMLElement) {
    return Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(i18n.t('host.delete_event'))
    );
  }

  it('stays disabled until the host types the album slug back', () => {
    const remove = vi.spyOn(eventsApi, 'remove');
    const { container } = renderDashboard({ planTier: 'pro_planner' });

    fireEvent.click(deleteButton(container)!);

    // The confirmation is the whole safeguard on an irreversible action.
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses a near-miss of the slug', () => {
    const remove = vi.spyOn(eventsApi, 'remove');
    const { container } = renderDashboard({ planTier: 'pro_planner' });

    const field = Array.from(container.querySelectorAll('input')).find(
      (i) => i.placeholder === baseEvent.slug
    );
    fireEvent.change(field!, { target: { value: 'ivan-and-maria ' } });
    fireEvent.click(deleteButton(container)!);

    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes once the slug matches exactly, and says what was destroyed', async () => {
    vi.spyOn(eventsApi, 'remove').mockResolvedValue({ photosDeleted: 143 } as never);
    const { container } = renderDashboard({ planTier: 'pro_planner' });

    const field = Array.from(container.querySelectorAll('input')).find(
      (i) => i.placeholder === baseEvent.slug
    );
    fireEvent.change(field!, { target: { value: baseEvent.slug } });
    fireEvent.click(deleteButton(container)!);

    await waitFor(() => expect(eventsApi.remove).toHaveBeenCalledWith('event-1', baseEvent.slug));
    await waitFor(() =>
      expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('143'))
    );
  });

  it('surfaces a failed deletion instead of navigating away', async () => {
    vi.spyOn(eventsApi, 'remove').mockRejectedValue(new Error('Still has photos'));
    const { container } = renderDashboard({ planTier: 'pro_planner' });

    const field = Array.from(container.querySelectorAll('input')).find(
      (i) => i.placeholder === baseEvent.slug
    );
    fireEvent.change(field!, { target: { value: baseEvent.slug } });
    fireEvent.click(deleteButton(container)!);

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Still has photos'));
  });
});

describe('the ZIP export', () => {
  it('streams via a short-lived ticket rather than fetching into memory', async () => {
    const ticket = vi
      .spyOn(eventsApi, 'requestExportTicket')
      .mockResolvedValue({ token: 'tkt', filename: 'wedding.zip' } as never);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const { container } = renderDashboard({ planTier: 'pro_planner' });
    openTab(container, 'host.export_zip');

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(i18n.t('host.zip_download'))
    );
    fireEvent.click(button!);

    await waitFor(() => expect(ticket).toHaveBeenCalledWith('event-1'));
    await waitFor(() => expect(click).toHaveBeenCalled());
  });

  it("shows the server's reason when the ticket is refused", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(eventsApi, 'requestExportTicket').mockRejectedValue(new Error('Plan does not include export'));

    const { container } = renderDashboard({ planTier: 'pro_planner' });
    openTab(container, 'host.export_zip');

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(i18n.t('host.zip_download'))
    );
    fireEvent.click(button!);

    // A tier refusal is not a session problem, and must not be reported as one.
    expect(await screen.findByText('Plan does not include export')).toBeTruthy();
  });
});
