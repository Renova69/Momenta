import React, { Suspense, lazy } from 'react';
import type { PlanTier, WeddingEvent } from '../../types';
import { isAlbumClosed } from '../../utils/albumStatus';

/**
 * The pricing table and the "My events" switcher: host dialogs that a guest
 * never opens. Each is mounted only while open. Mounted closed, a lazy
 * component still fetches its chunk, so every guest's phone downloaded both
 * on the album page.
 *
 * The pricing table is also a full view of its own (`/pricing`), which App
 * renders from the same lazy component.
 */
export const PricingPlansModal = lazy(() =>
  import('./PricingPlansModal').then((m) => ({ default: m.PricingPlansModal }))
);
const HostEventsList = lazy(() =>
  import('./HostEventsList').then((m) => ({ default: m.HostEventsList }))
);

interface HostDialogsProps {
  event: WeddingEvent;
  isPricingOpen: boolean;
  onClosePricing: () => void;
  onUpgradePlan: (newTier: PlanTier) => Promise<void>;
  /** Set while nobody is signed in: choosing a plan goes to sign-in (N-151). */
  onSignInRequired?: () => void;
  isEventsListOpen: boolean;
  onCloseEventsList: () => void;
  onSelectEvent: (event: WeddingEvent) => void;
  onCreateEvent: (newEvent: Partial<WeddingEvent>) => Promise<void>;
  onOpenPricingFromList: () => void;
}

export const HostDialogs: React.FC<HostDialogsProps> = ({
  event,
  isPricingOpen,
  onClosePricing,
  onUpgradePlan,
  onSignInRequired,
  isEventsListOpen,
  onCloseEventsList,
  onSelectEvent,
  onCreateEvent,
  onOpenPricingFromList,
}) => (
  // No fallback: a dialog that has not arrived yet shows nothing rather than a
  // spinner over the page. The pricing table had no boundary at all, so the
  // first paint of every album waited for its chunk.
  <Suspense fallback={null}>
    {isPricingOpen && (
      <PricingPlansModal
        isOpen
        onClose={onClosePricing}
        currentPlanTier={event.planTier || 'free'}
        onUpgradePlan={onUpgradePlan}
        eventSlug={event.slug}
        albumClosed={isAlbumClosed(event.expiresAt)}
        onSignInRequired={onSignInRequired}
      />
    )}
    {isEventsListOpen && (
      <HostEventsList
        isOpen
        onClose={onCloseEventsList}
        currentEvent={event}
        onSelectEvent={onSelectEvent}
        onCreateEvent={onCreateEvent}
        onOpenPricing={onOpenPricingFromList}
      />
    )}
  </Suspense>
);
