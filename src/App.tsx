import React, { Suspense, lazy, useState, useEffect, useCallback } from 'react';
import {
  ThemePalette,
  PlanTier,
  PhotoReactionKind,
  WeddingEvent,
  Guest,
} from './types';
import { THEMES } from './config/themes';
import { i18n } from './i18n';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppProvider, useApp } from './context/AppContext';
import { router } from './router';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { LoadingSpinner } from './components/common/LoadingSpinner';
import { EventNotFound } from './components/common/EventNotFound';
import { eventsApi } from './api/eventsApi';
import { Navbar } from './components/layout/Navbar';
import { BottomNav } from './components/layout/BottomNav';
import { WeddingHero } from './components/layout/WeddingHero';
import { LiveFeed } from './components/gallery/LiveFeed';
import { CameraCaptureModal } from './components/camera/CameraCaptureModal';
import { LightboxModal } from './components/gallery/LightboxModal';
import { GuestOnboardingModal } from './components/guest/GuestOnboardingModal';

/**
 * Everything below is loaded when it is first needed, not before.
 *
 * A guest arriving at an album used to download the whole application: the
 * host dashboard with its QR print studio and moderation queue, the projector
 * wall, the photographer's portal, the pricing table — none of which a guest
 * can even open. On the phone, on the venue's Wi-Fi, during the party. That
 * is the one network this app runs on and the one it was heaviest for.
 *
 * What stays eager is exactly what a guest sees: the feed, the camera, the
 * lightbox, the onboarding. Waiting on a chunk after tapping "Snap Photo"
 * would be a worse trade than the bytes.
 */
const ScavengerHunt = lazy(() =>
  import('./components/quests/ScavengerHunt').then((m) => ({ default: m.ScavengerHunt }))
);
const AudioGuestbook = lazy(() =>
  import('./components/audio/AudioGuestbook').then((m) => ({ default: m.AudioGuestbook }))
);
const HostDashboard = lazy(() =>
  import('./components/host/HostDashboard').then((m) => ({ default: m.HostDashboard }))
);
const LiveProjectorScreen = lazy(() =>
  import('./components/projector/LiveProjectorScreen').then((m) => ({ default: m.LiveProjectorScreen }))
);
const PricingPlansModal = lazy(() =>
  import('./components/host/PricingPlansModal').then((m) => ({ default: m.PricingPlansModal }))
);
const HostProfileModal = lazy(() =>
  import('./components/host/HostProfileModal').then((m) => ({ default: m.HostProfileModal }))
);
const HostEventsList = lazy(() =>
  import('./components/host/HostEventsList').then((m) => ({ default: m.HostEventsList }))
);
const HostAuthPage = lazy(() =>
  import('./components/host/HostAuthPage').then((m) => ({ default: m.HostAuthPage }))
);
const LandingHomePage = lazy(() =>
  import('./components/home/LandingHomePage').then((m) => ({ default: m.LandingHomePage }))
);
const PhotographerIngestPortal = lazy(() =>
  import('./components/ingest/PhotographerIngestPortal').then((m) => ({ default: m.PhotographerIngestPortal }))
);
import { isFeatureUnlocked } from './config/tierGating';
import { useQuestLeaderboard } from './hooks/useQuestLeaderboard';
import { useCheckoutReturn } from './hooks/useCheckoutReturn';
import { useLightboxPhoto } from './hooks/useLightboxPhoto';
import type { RemoteEventPayload } from './services/eventNormalization';
import { LockedFeatureCard } from './components/common/LockedFeatureBadge';
import {
  Heart,
  Trophy,
  Mic,
  Layers,
  WifiOff,
  CloudUpload,
} from 'lucide-react';

function WeddingAppContent() {
  const {
    event,
    guests,
    currentGuest,
    photos,
    quests,
    audioEntries,
    qrConfig,
    activeView,
    activeGuestTab,
    isLoadingEvent,
    eventError,
    eventErrorKind,
    missingSlug,
    retryEventLoad,
    queuedUploadCount,
    isNetworkOnline,
    pendingPhotosCount,
    syncError,
    dismissSyncError,
    navigateView,
    navigateGuestTab,
    loadEventBySlug,
    openSignedInAlbum,
    ensureOwnAlbum,
    refreshEventDetails,
    updateEvent,
    upgradePlanTier,
    updateQRConfig,
    registerGuest,
    addPhoto,
    toggleLikePhoto,
    togglePhotoReaction,
    addComment,
    setPhotoStatus,
    deletePhoto,
    addQuest,
    deleteQuest,
    addAudioEntry,
    resetDefaults,
  } = useApp();

  const { user: currentHostUser, logout: hostLogout, updateProfile } = useAuth();

  // Modals state
  const [isCaptureOpen, setIsCaptureOpen] = useState(false);
  const [selectedQuestForCapture, setSelectedQuestForCapture] = useState<string | undefined>(undefined);
  // N-113 — by id, read from the live list, so what happens inside it shows.
  const lightbox = useLightboxPhoto(photos);
  const [isGuestProfileOpen, setIsGuestProfileOpen] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const [isEventsListOpen, setIsEventsListOpen] = useState(false);
  // N-132 — which form the host studio opens on: the landing page's "create
  // a free album" buttons mean sign-up.
  const [hostAuthTab, setHostAuthTab] = useState<'signin' | 'signup'>('signin');
  const [isHostProfileOpen, setIsHostProfileOpen] = useState(false);
  // Stripe redirects the browser back here after a real checkout. The plan is
  // granted by the webhook, not by this redirect, so the banner says what is
  // actually known and keeps checking until the plan arrives (N-54). The
  // refresh is the quiet one: loadEventBySlug would put up the full-screen
  // spinner and move the host to the guest feed on every poll.
  const [checkoutBanner, dismissCheckoutBanner] = useCheckoutReturn(event?.planTier, refreshEventDetails);

  const currentTheme = (event?.themePalette && THEMES[event.themePalette]) ? THEMES[event.themePalette] : THEMES.champagne_gold;

  // Auto-open guest onboarding ONLY when visiting a specific event URL (/e/:slug) and not yet registered
  useEffect(() => {
    const routeSlug = router.getRoute().slug;
    if (routeSlug && !currentGuest && activeView === 'guest' && !isLoadingEvent) {
      setIsGuestProfileOpen(true);
    }
  }, [currentGuest, activeView, isLoadingEvent]);
  // Handlers
  const handleOpenCaptureForQuest = (questId: string) => {
    setSelectedQuestForCapture(questId);
    setIsCaptureOpen(true);
  };

  const handleOpenGeneralCapture = useCallback(() => {
    setSelectedQuestForCapture(undefined);
    setIsCaptureOpen(true);
  }, []);

  const handleAddComment = (photoId: string, commentText: string) => {
    if (!currentGuest || currentGuest.id === 'anonymous') {
      setIsGuestProfileOpen(true);
      return;
    }
    addComment(photoId, commentText);
  };

  const handleUpgradePlan = (newTier: PlanTier): Promise<void> => {
    return upgradePlanTier(newTier);
  };

  // [FIX C-8] Load the selected event by slug instead of overwriting current event
  // N-116 — the switcher is the host's: choosing an album opens its studio.
  // It opened the guest view, which then asked the host to join as a guest.
  const handleSelectEvent = async (selectedEvent: WeddingEvent) => {
    if (selectedEvent.slug) {
      await loadEventBySlug(selectedEvent.slug);
    }
    navigateView('host');
  };

  // N-119, N-120 — the studio drew whatever album this browser had cached:
  // the demo wedding after "reset local data", or one the host had just
  // deleted. Open one of their own instead, or their albums if they have none.
  useEffect(() => {
    if (activeView !== 'host' || !currentHostUser?.id || event.hostUserId === currentHostUser.id) return;
    let cancelled = false;
    ensureOwnAlbum(currentHostUser.id)
      .then((outcome) => {
        if (!cancelled && outcome === 'none') setIsEventsListOpen(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeView, currentHostUser?.id, event.id, event.hostUserId, ensureOwnAlbum]);

  // Create event via API, then load it and navigate to the host view.
  const handleCreateEvent = async (newEventData: Partial<WeddingEvent>) => {
    const created = await eventsApi.create(newEventData);
    if (!created || !created.slug) {
      throw new Error('Event creation returned no slug');
    }
    await loadEventBySlug(created.slug);
    navigateView('host');
  };

  // M3 — these are props of memoized children (LiveFeed, PhotoCard). Recreating
  // them on every render would change prop identity every time and defeat the
  // memo comparison entirely, which is the whole point of memoizing.
  const handleLikeWithPrompt = useCallback(
    (photoId: string) => {
      if (!currentGuest || currentGuest.id === 'anonymous') {
        setIsGuestProfileOpen(true);
        return;
      }
      toggleLikePhoto(photoId);
    },
    [currentGuest, toggleLikePhoto]
  );

  const handleReactWithPrompt = useCallback(
    (photoId: string, reaction: PhotoReactionKind) => {
      if (!currentGuest || currentGuest.id === 'anonymous') {
        setIsGuestProfileOpen(true);
        return;
      }
      togglePhotoReaction(photoId, reaction);
    },
    [currentGuest, togglePhotoReaction]
  );

  const handleOpenLightbox = lightbox.open;

  // Fetched only while a guest is looking at it; see useQuestLeaderboard.
  const guestLeaderboard = useQuestLeaderboard(
    event?.id,
    activeView === 'guest' && activeGuestTab === 'quests' && isFeatureUnlocked(event?.planTier, 'scavenger_quests'),
    quests,
    photos
  );

  // Loading state
  if (isLoadingEvent) {
    return <LoadingSpinner fullscreen message={i18n.t('common.loading')} />;
  }

  // Not Found state
  if (eventError) {
    return (
      <EventNotFound
        // The address that failed, not whichever album happens to be loaded:
        // this used to name the album the guest had just been looking at, or
        // the seeded demo one on a first visit.
        slug={missingSlug ?? undefined}
        reason={eventErrorKind}
        onRetry={retryEventLoad}
        onGoHome={() => navigateView('host')}
        onCreateEvent={() => navigateView('host')}
      />
    );
  }



  const fallbackGuest: Guest = {
    id: 'anonymous',
    eventId: event?.id || '',
    name: i18n.t('guest.fallback_name'),
    createdAt: new Date().toISOString()
  };
  const safeGuest = currentGuest || fallbackGuest;

  return (
    <div className={`min-h-screen bg-gradient-to-b ${currentTheme.bgGradient} text-cream-100 flex flex-col`}>
      {/* Network Status Indicators */}
      {!isNetworkOnline && (
        <div className="bg-red-500 text-white px-4 py-1 text-xs font-bold flex items-center justify-center gap-2 sticky top-0 z-50">
          <WifiOff className="w-3.5 h-3.5" />
          <span>{i18n.t('common.offline_notice')}</span>
        </div>
      )}

      {(checkoutBanner === 'confirming' || checkoutBanner === 'active' || checkoutBanner === 'delayed') && (
        <div
          role="status"
          className={`${checkoutBanner === 'active' ? 'bg-sage-600 text-white' : 'bg-noir-700 text-cream-100 border-b border-gold-400/20'} px-4 py-2 text-xs font-bold flex items-center justify-center gap-3 sticky top-0 z-50`}
        >
          <span>
            {i18n.t(
              checkoutBanner === 'active'
                ? 'billing.checkout_success'
                : checkoutBanner === 'delayed'
                ? 'billing.checkout_delayed'
                : 'billing.checkout_confirming'
            )}
          </span>
          <button onClick={dismissCheckoutBanner} className="underline underline-offset-2 hover:opacity-80">
            {i18n.t('common.dismiss')}
          </button>
        </div>
      )}

      {checkoutBanner === 'cancelled' && (
        <div className="bg-noir-700 text-cream-100 px-4 py-2 text-xs font-bold flex items-center justify-center gap-3 sticky top-0 z-50 border-b border-cream-400/10">
          <span>{i18n.t('billing.checkout_cancelled')}</span>
          <button onClick={dismissCheckoutBanner} className="underline underline-offset-2 hover:opacity-80">
            {i18n.t('common.dismiss')}
          </button>
        </div>
      )}

      {syncError && (
        <div className="bg-red-600 text-white px-4 py-2 text-xs font-bold flex items-center justify-center gap-3 sticky top-0 z-50">
          <span>{i18n.t('common.save_failed')}: {syncError}</span>
          <button
            onClick={dismissSyncError}
            className="underline underline-offset-2 hover:opacity-80"
          >
            {i18n.t('common.dismiss')}
          </button>
        </div>
      )}

      {queuedUploadCount > 0 && isNetworkOnline && (
        <div className="bg-gold-500 text-noir-900 px-4 py-1 text-xs font-bold flex items-center justify-center gap-2 sticky top-0 z-50">
          <CloudUpload className="w-3.5 h-3.5 animate-bounce" />
          <span>{i18n.t('common.syncing')}</span>
        </div>
      )}

      {/* Top Navbar */}
      <Navbar
        activeView={activeView}
        setActiveView={navigateView}
        onLogoClick={() => {
          router.navigate('guest', undefined, 'feed');
        }}
        isHomePage={!router.getRoute().slug}
        currentTheme={event.themePalette}
        onThemeChange={(newTheme: ThemePalette) => updateEvent({ themePalette: newTheme })}
        currentGuest={safeGuest}
        onOpenGuestProfile={() => setIsGuestProfileOpen(true)}
        onOpenPricing={() => setIsPricingOpen(true)}
        onOpenEventsList={() => setIsEventsListOpen(true)}
        currentPlanTier={event.planTier || 'free'}
        pendingCount={pendingPhotosCount}
        currentHostUser={currentHostUser}
        onHostLogout={() => {
          hostLogout();
          navigateView('guest');
        }}
        onOpenHostAuth={() => navigateView('host')}
        onOpenHostProfile={() => setIsHostProfileOpen(true)}
      />

      {/* MAIN VIEW CONTENT */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 pb-28 sm:pb-8">
        {/* One boundary for the whole view area: only one view is on screen at
            a time, and a spinner in the content region is what a slow chunk
            should look like. */}
        <Suspense fallback={<LoadingSpinner />}>
        {/* VIEW 1: GUEST EXPERIENCE OR ROOT HOME LANDING */}
        {activeView === 'guest' && (
          <div className="space-y-6 sm:space-y-8 animate-fade-in">
            {!router.getRoute().slug ? (
              <LandingHomePage
                onSelectWedding={(slug) => {
                  loadEventBySlug(slug);
                }}
                onOpenCreateEvent={() => {
                  setHostAuthTab('signup');
                  navigateView('host');
                }}
                onOpenPricing={() => setIsPricingOpen(true)}
              />
            ) : (
              <>
                {/* Hero Header for Active Wedding Album */}
                <WeddingHero
                  event={event}
                  guests={guests}
                  photos={photos}
                  quests={quests}
                  audioEntries={audioEntries}
                  onOpenCapture={handleOpenGeneralCapture}
                  onOpenAudio={() => navigateGuestTab('audio')}
                  onOpenQuests={() => navigateGuestTab('quests')}
                />

                {/* Guest Sub-Navigation Tabs (Desktop Only) */}
                <div className="hidden sm:flex items-center justify-center gap-2 sm:gap-4 p-1.5 bg-noir-800/80 rounded-2xl max-w-md mx-auto border border-cream-400/10 backdrop-blur-md">
                  <button
                    onClick={() => navigateGuestTab('feed')}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-bold transition-all ${
                      activeGuestTab === 'feed'
                        ? `${currentTheme.buttonPrimary} shadow-sm`
                        : 'text-cream-400 hover:text-cream-100'
                    }`}
                  >
                    <Layers className="w-4 h-4" />
                    <span>{i18n.t('feed.all_moments')}</span>
                  </button>

                  <button
                    onClick={() => navigateGuestTab('quests')}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-bold transition-all ${
                      activeGuestTab === 'quests'
                        ? `${currentTheme.buttonPrimary} shadow-sm`
                        : 'text-cream-400 hover:text-cream-100'
                    }`}
                  >
                    <Trophy className="w-4 h-4" />
                    <span>{i18n.t('feed.quests')}</span>
                  </button>

                  <button
                    onClick={() => navigateGuestTab('audio')}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-bold transition-all ${
                      activeGuestTab === 'audio'
                        ? `${currentTheme.buttonPrimary} shadow-sm`
                        : 'text-cream-400 hover:text-cream-100'
                    }`}
                  >
                    <Mic className="w-4 h-4" />
                    <span>{i18n.t('hero.audio_toast')}</span>
                  </button>
                </div>

                {/* Active Guest Tab Panel */}
                {activeGuestTab === 'feed' && (
                  <LiveFeed
                    photos={photos}
                    currentGuest={safeGuest}
                    eventPlanTier={event.planTier}
                    onOpenPricing={() => setIsPricingOpen(true)}
                    onLike={handleLikeWithPrompt}
                    onReact={handleReactWithPrompt}
                    onOpenComments={handleOpenLightbox}
                    onOpenLightbox={handleOpenLightbox}
                    onOpenCapture={handleOpenGeneralCapture}
                  />
                )}

                {activeGuestTab === 'quests' && (
                  !isFeatureUnlocked(event.planTier, 'scavenger_quests') ? (
                    <div className="py-8">
                      <LockedFeatureCard feature="scavenger_quests" onOpenPricing={() => setIsPricingOpen(true)} />
                    </div>
                  ) : (
                    <ScavengerHunt
                      quests={quests}
                      currentGuest={safeGuest}
                      photos={photos}
                      prize={event.questPrize}
                      leaderboard={guestLeaderboard}
                      onSelectQuestForCapture={handleOpenCaptureForQuest}
                    />
                  )
                )}

                {activeGuestTab === 'audio' && (
                  !isFeatureUnlocked(event.planTier, 'audio_guestbook') ? (
                    <div className="py-8">
                      <LockedFeatureCard feature="audio_guestbook" onOpenPricing={() => setIsPricingOpen(true)} />
                    </div>
                  ) : (
                    <AudioGuestbook
                      entries={audioEntries}
                      onAddAudioEntry={addAudioEntry}
                    />
                  )
                )}
              </>
            )}
          </div>
        )}

        {/* VIEW 2: HOST STUDIO (Protected by Host Authentication Guard) */}
        {activeView === 'host' && (
          <div className="animate-fade-in">
            {currentHostUser ? (
              <HostDashboard
                event={event}
                guests={guests}
                photos={photos}
                quests={quests}
                audioEntries={audioEntries}
                qrConfig={qrConfig}
                onUpdateEvent={updateEvent}
                onUpdateQRConfig={updateQRConfig}
                onSetPhotoStatus={setPhotoStatus}
                onDeletePhoto={deletePhoto}
                onAddQuest={addQuest}
                onDeleteQuest={deleteQuest}
                onResetData={resetDefaults}
                onOpenPricing={() => setIsPricingOpen(true)}
              />
            ) : (
              <HostAuthPage
                key={hostAuthTab}
                initialTab={hostAuthTab}
                onSuccess={async (_user, newEvent) => {
                  // N-110 — read from the server, never merged in raw: the
                  // sign-in answer's row kept a cached album's (or the demo's)
                  // couple, date, venue and settings on screen.
                  if (newEvent?.slug) await openSignedInAlbum(newEvent as RemoteEventPayload);
                  navigateView('host');
                }}
                onCancel={() => navigateView('guest')}
              />
            )}
          </div>
        )}

        {/* VIEW 3: LIVE PROJECTOR TV SCREEN */}
        {activeView === 'projector' && (
          !isFeatureUnlocked(event.planTier, 'live_tv') ? (
            <div className="py-12 px-4 max-w-xl mx-auto">
              <LockedFeatureCard feature="live_tv" onOpenPricing={() => setIsPricingOpen(true)} />
            </div>
          ) : (
            <LiveProjectorScreen
              event={event}
              photos={photos}
              quests={quests}
              onClose={() => navigateView('guest')}
            />
          )
        )}

        {/* VIEW: PHOTOGRAPHER INGEST PORTAL (passwordless via ?key=) */}
        {activeView === 'ingest' && (
          <PhotographerIngestPortal
            event={event}
            onClose={() => navigateView('guest')}
          />
        )}

        {/* VIEW 4: PRICING PLANS */}
        {activeView === 'pricing' && (
          <div className="py-6 animate-fade-in">
            <PricingPlansModal
              isOpen={true}
              onClose={() => navigateView('host')}
              currentPlanTier={event.planTier || 'free'}
              onUpgradePlan={handleUpgradePlan}
              eventSlug={event.slug}
            />
          </div>
        )}
        </Suspense>
      </main>

      {/* MOBILE BOTTOM NAVIGATION BAR — only when viewing an event */}
      {router.getRoute().slug && (
        <BottomNav
          activeView={activeView}
          activeGuestTab={activeGuestTab}
          onSelectTab={navigateGuestTab}
          onSelectView={navigateView}
          onOpenCapture={handleOpenGeneralCapture}
          photosCount={photos.length}
          questsCount={quests.length}
          audioCount={audioEntries.length}
          pendingCount={pendingPhotosCount}
          currentHostUser={currentHostUser}
        />
      )}

      {/* MODALS */}
      {/* 1. Camera Capture / Filter Modal */}
      <CameraCaptureModal
        isOpen={isCaptureOpen}
        onClose={() => setIsCaptureOpen(false)}
        currentGuest={safeGuest}
        quests={quests}
        selectedQuestId={selectedQuestForCapture}
        onPhotoUploaded={addPhoto}
      />

      {/* 2. Fullscreen Lightbox & Comments Modal */}
      <LightboxModal
        photo={lightbox.photo}
        onClose={lightbox.close}
        currentGuest={safeGuest}
        onLike={handleLikeWithPrompt}
        onReact={handleReactWithPrompt}
        onAddComment={handleAddComment}
      />

      {/* 3. Guest Profile / Onboarding Modal */}
      <GuestOnboardingModal
        isOpen={isGuestProfileOpen}
        onClose={() => setIsGuestProfileOpen(false)}
        currentGuest={safeGuest}
        onSaveGuest={registerGuest}
      />

      {/* 4. SaaS Pricing & Subscription Modal */}
      <PricingPlansModal
        isOpen={isPricingOpen}
        onClose={() => setIsPricingOpen(false)}
        currentPlanTier={event.planTier || 'free'}
        onUpgradePlan={handleUpgradePlan}
        eventSlug={event.slug}
      />

      {/* 4b. Host Account Profile Modal */}
      {/* No fallback: a dialog that has not arrived yet should show nothing,
          not a spinner floating over the page behind it. */}
      <Suspense fallback={null}>
        {currentHostUser && (
          <HostProfileModal
            isOpen={isHostProfileOpen}
            onClose={() => setIsHostProfileOpen(false)}
            hostUser={currentHostUser}
            onSaveName={updateProfile}
          />
        )}

        {/* 5. Host Events Switcher Modal */}
        <HostEventsList
          isOpen={isEventsListOpen}
          onClose={() => setIsEventsListOpen(false)}
          currentEvent={event}
          onSelectEvent={handleSelectEvent}
          onCreateEvent={handleCreateEvent}
          onOpenPricing={() => {
            setIsEventsListOpen(false);
            setIsPricingOpen(true);
          }}
        />
      </Suspense>

      {/* Footer */}
      <footer className="mt-16 py-8 border-t border-cream-400/10 text-center text-xs text-cream-400/60">
        <div className="flex items-center justify-center gap-1.5 mb-1 font-serif text-sm text-gold-400/80">
          <Heart className="w-3.5 h-3.5 fill-gold-400 text-gold-400" />
          <span>{i18n.t('ui.app.1')}</span>
        </div>
        <p>{i18n.t('ui.app.2')}</p>
      </footer>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppProvider>
          <WeddingAppContent />
        </AppProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
