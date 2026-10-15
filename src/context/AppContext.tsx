import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, ReactNode } from 'react';
import {
  WeddingEvent,
  Guest,
  Photo,
  ScavengerQuest,
  AudioGuestbookEntry,
  QRCanvasConfig,
  PhotoStatus,
  PhotoFilter,
  PhotoReactionKind,
  ActiveView,
  PlanTier
} from '../types';
import type { RemoteEventPayload } from '../services/eventNormalization';
import type { CoverSource } from '../api/eventsApi';
import { storageService } from '../services/storageService';
import { offlineQueue } from '../services/offlineQueueService';
import { router, RouteState } from '../router';
import { i18n } from '../i18n';

interface AppContextType {
  event: WeddingEvent;
  guests: Guest[];
  currentGuest: Guest | null;
  photos: Photo[];
  quests: ScavengerQuest[];
  audioEntries: AudioGuestbookEntry[];
  qrConfig: QRCanvasConfig;
  activeView: ActiveView;
  activeGuestTab: 'feed' | 'quests' | 'audio';
  /** The album at the address is not here yet: the loading screen. */
  isLoadingEvent: boolean;
  /** An album is being opened: its record may be here, the rest still coming. */
  isSyncingAlbum: boolean;
  eventError: string | null;
  /** Whether the album is missing, or the server could not be reached to ask. */
  eventErrorKind: 'missing' | 'unreachable' | 'deleted';
  /** The address that failed — not the album that happens to be loaded. */
  missingSlug: string | null;
  /** Try the failed address again, for the unreachable case. */
  retryEventLoad: () => void;
  queuedUploadCount: number;
  isNetworkOnline: boolean;
  pendingPhotosCount: number;
  syncError: string | null;
  dismissSyncError: () => void;

  // Navigation
  navigateView: (view: ActiveView, tab?: 'feed' | 'quests' | 'audio') => void;
  navigateGuestTab: (tab: 'feed' | 'quests' | 'audio') => void;
  loadEventBySlug: (slug: string) => Promise<WeddingEvent | null>;
  /** Open the album a host just signed in to, read from the server (N-110). */
  openSignedInAlbum: (signedIn: RemoteEventPayload) => Promise<void>;
  /** Open an album the signed-in host owns, if the one shown is not (N-119, N-120). */
  ensureOwnAlbum: (hostUserId: string) => Promise<'kept' | 'opened' | 'none'>;

  // Actions
  updateEvent: (updates: Partial<WeddingEvent>) => void;
  upgradePlanTier: (tier: PlanTier) => Promise<void>;
  /** Set or remove the album's cover through its own route (N-139). */
  setCover: (source: CoverSource) => Promise<void>;
  removeCover: () => Promise<void>;
  /** Re-read the album record quietly: no loading screen, no navigation. */
  refreshEventDetails: () => Promise<void>;
  updateQRConfig: (updates: Partial<QRCanvasConfig>) => void;
  registerGuest: (name: string, tableNumber?: string, avatarUrl?: string) => Promise<Guest>;
  addPhoto: (photoData: {
    guestId: string;
    guestName: string;
    guestAvatar?: string;
    guestTable?: string;
    fullUrl: string;
    thumbnailUrl?: string;
    originalUrl?: string;
    caption?: string;
    filterApplied?: PhotoFilter;
    questId?: string;
    questTitle?: string;
  }) => Promise<Photo>;
  toggleLikePhoto: (photoId: string) => void;
  togglePhotoReaction: (photoId: string, reaction: PhotoReactionKind) => void;
  addComment: (photoId: string, commentText: string) => void;
  setPhotoStatus: (photoId: string, status: PhotoStatus) => void;
  deletePhoto: (photoId: string) => void;
  addQuest: (title: string, description: string, iconName?: string, points?: number) => ScavengerQuest;
  deleteQuest: (questId: string) => void;
  completeQuest: (questId: string) => void;
  addAudioEntry: (audioBlob: Blob, durationSeconds: number, note?: string, mimeType?: string) => AudioGuestbookEntry;
  resetDefaults: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [event, setEvent] = useState<WeddingEvent>(() => storageService.getEvent());
  const [guests, setGuests] = useState<Guest[]>(() => storageService.getGuests());
  const [currentGuest, setCurrentGuest] = useState<Guest | null>(() => storageService.getCurrentGuest());
  const [photos, setPhotos] = useState<Photo[]>(() => storageService.getPhotos());
  const [quests, setQuests] = useState<ScavengerQuest[]>(() => storageService.getQuests());
  const [audioEntries, setAudioEntries] = useState<AudioGuestbookEntry[]>(() => storageService.getAudioEntries());
  const [qrConfig, setQRConfig] = useState<QRCanvasConfig>(() => storageService.getQRCanvasConfig());

  const [activeView, setActiveView] = useState<ActiveView>(() => router.getRoute().view);
  const [activeGuestTab, setActiveGuestTab] = useState<'feed' | 'quests' | 'audio'>(() => router.getRoute().subTab || 'feed');
  // The address being opened, from the very first render. A guest opening a
  // link saw the built-in demo album for a frame before the loading screen
  // (N-137), and then that screen until every part of the album had arrived
  // (N-136). The page waits only for the album's own record now.
  const [loadingSlug, setLoadingSlug] = useState<string | null>(() => {
    const { slug } = router.getRoute();
    return slug && slug !== storageService.getEvent().slug ? slug : null;
  });
  /** The album at this address is not here yet. */
  const isLoadingEvent = loadingSlug !== null && event.slug !== loadingSlug;
  /** Its record is; its photos, quests and the rest may still be on the way. */
  const isSyncingAlbum = loadingSlug !== null;
  const startLoading = (slug: string) => setLoadingSlug(slug);
  // A newer address may have been opened meanwhile; that one keeps waiting.
  const stopLoading = (slug: string) => setLoadingSlug((current) => (current === slug ? null : current));
  const [eventError, setEventError] = useState<string | null>(null);
  /** Which kind of failure `eventError` describes: no such album, or could not ask. */
  const [eventErrorKind, setEventErrorKind] = useState<'missing' | 'unreachable' | 'deleted'>('missing');
  /** The address that failed, which is not the album currently loaded. */
  const [missingSlug, setMissingSlug] = useState<string | null>(null);

  const [syncError, setSyncError] = useState<string | null>(null);
  const [queuedUploadCount, setQueuedUploadCount] = useState<number>(0);
  const [isNetworkOnline, setIsNetworkOnline] = useState<boolean>(true);
  const [, setLangTick] = useState<number>(0);

  // Mount-only: this wires up the router, storage, queue and i18n subscriptions.
  // `event.slug` is read once to decide whether the initial URL needs loading;
  // depending on it would tear down and rebuild every subscription on each
  // event change.
  useEffect(() => {
    // 1. Initial slug detection & event load
    const initialRoute = router.getRoute();
    if (initialRoute.slug && initialRoute.slug !== event.slug) {
      const slug = initialRoute.slug;
      startLoading(slug);
      storageService.loadEventBySlug(slug)
        .then((res) => {
          if (!res) failEventLoad(slug, 'missing', `Event not found: ${slug}`);
          else setEventError(null);
        })
        .catch((e) => failEventLoad(slug, 'unreachable', e.message))
        .finally(() => stopLoading(slug));
    }

    // 2. Storage service subscriber
    const readStore = () => {
      setEvent(storageService.getEvent());
      setGuests(storageService.getGuests());
      setCurrentGuest(storageService.getCurrentGuest());
      setPhotos(storageService.getPhotos());
      setQuests(storageService.getQuests());
      setAudioEntries(storageService.getAudioEntries());
      setQRConfig(storageService.getQRCanvasConfig());
    };
    const unsubStorage = storageService.subscribe(readStore);
    // Read once now as well (N-148): the store starts work before the first
    // render, and what it finished between that render and this subscription
    // reached no listener.
    readStore();

    // 3. Router subscriber
    const unsubRouter = router.subscribe((route: RouteState) => {
      setActiveView(route.view);
      if (route.subTab) setActiveGuestTab(route.subTab);
      if (route.slug && route.slug !== storageService.getEvent().slug) {
        const slug = route.slug;
        startLoading(slug);
        storageService.loadEventBySlug(slug)
          .then((res) => {
            if (!res) failEventLoad(slug, 'missing', `Event not found: ${slug}`);
            else setEventError(null);
          })
          .catch((e) => failEventLoad(slug, 'unreachable', e.message))
          .finally(() => stopLoading(slug));
      }
    });

    // 4. Offline queue subscriber
    const unsubQueue = offlineQueue.subscribe((count, online) => {
      setQueuedUploadCount(count);
      setIsNetworkOnline(online);
    });

    // 5. i18n subscriber
    const unsubI18n = i18n.subscribe(() => {
      setLangTick((t) => t + 1);
    });

    // 6. Surface writes the server refused instead of failing silently
    const unsubErrors = storageService.subscribeErrors((message) => {
      setSyncError(message);
    });

    // The host erased the album while this browser was in it. Nothing here is
    // valid any more; say so instead of letting the guest carry on until
    // their next upload fails for no stated reason.
    const unsubGone = storageService.subscribeEventGone((goneEventId) => {
      const route = router.getRoute();
      setMissingSlug(route.slug ?? storageService.getEvent().slug ?? null);
      setEventErrorKind('deleted');
      setEventError(`Event deleted: ${goneEventId}`);
    });

    return () => {
      unsubStorage();
      unsubRouter();
      unsubGone();
      unsubQueue();
      unsubI18n();
      unsubErrors();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const failEventLoad = (slug: string, kind: 'missing' | 'unreachable' | 'deleted', message: string) => {
    setMissingSlug(slug);
    setEventErrorKind(kind);
    setEventError(message);
  };

  const navigateView = (view: ActiveView, tab?: 'feed' | 'quests' | 'audio') => {
    // Leaving a failed address has to drop it. Carrying the slug along meant
    // the router immediately tried to load it again, re-raised the same
    // error, and bounced the guest back to the dead end they had just left —
    // escapable only by editing the URL.
    const leavingFailure = eventError !== null;
    setEventError(null);
    if (leavingFailure) setMissingSlug(null);
    setActiveView(view);
    if (tab) setActiveGuestTab(tab);
    const currentSlug = leavingFailure ? undefined : router.getRoute().slug;
    router.navigate(view, currentSlug, tab || activeGuestTab);
  };

  const navigateGuestTab = (tab: 'feed' | 'quests' | 'audio') => {
    setEventError(null);
    setActiveGuestTab(tab);
    const currentSlug = router.getRoute().slug;
    router.navigate('guest', currentSlug, tab);
  };

  /** Ask again for the address that failed. Only useful for the unreachable case. */
  const retryEventLoad = () => {
    const slug = missingSlug ?? router.getRoute().slug;
    if (slug) void loadEventBySlug(slug);
  };

  const loadEventBySlug = async (slug: string): Promise<WeddingEvent | null> => {
    startLoading(slug);
    try {
      const loaded = await storageService.loadEventBySlug(slug);
      if (!loaded) {
        failEventLoad(slug, 'missing', `Event not found: ${slug}`);
      } else {
        setEventError(null);
        setMissingSlug(null);
        router.navigate('guest', slug, 'feed');
      }
      return loaded;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      failEventLoad(slug, 'unreachable', errorMsg || 'Error loading event');
      return null;
    } finally {
      stopLoading(slug);
    }
  };

  const openSignedInAlbum = useCallback((signedIn: RemoteEventPayload) => storageService.openSignedInAlbum(signedIn), []);
  const ensureOwnAlbum = useCallback((hostUserId: string) => storageService.ensureOwnAlbum(hostUserId), []);

  const updateEvent = useCallback((updates: Partial<WeddingEvent>) => {
    storageService.updateEvent(updates);
  }, []);

  const refreshEventDetails = useCallback(() => storageService.refreshEventDetails(), []);

  const upgradePlanTier = useCallback(async (tier: PlanTier) => {
    return storageService.upgradePlanTier(tier);
  }, []);

  const setCover = useCallback((source: CoverSource) => storageService.setCover(source), []);
  const removeCover = useCallback(() => storageService.removeCover(), []);

  const updateQRConfig = useCallback((updates: Partial<QRCanvasConfig>) => {
    storageService.updateQRCanvasConfig(updates);
  }, []);

  const registerGuest = async (name: string, tableNumber?: string, avatarUrl?: string) => {
    return storageService.registerGuest(name, tableNumber, avatarUrl);
  };

  const addPhoto = async (photoData: {
    guestId: string;
    guestName: string;
    guestAvatar?: string;
    guestTable?: string;
    fullUrl: string;
    thumbnailUrl?: string;
    originalUrl?: string;
    caption?: string;
    filterApplied?: PhotoFilter;
    questId?: string;
    questTitle?: string;
  }) => {
    return storageService.addPhoto(photoData);
  };

  // [FIX H-7] Do not fall back to 'anonymous' — require a real guest identity
  const toggleLikePhoto = useCallback((photoId: string) => {
    if (!currentGuest || currentGuest.id === 'anonymous') return; // silently no-op
    storageService.toggleLikePhoto(photoId, currentGuest.id);
  }, [currentGuest]);

  const togglePhotoReaction = useCallback((photoId: string, reaction: PhotoReactionKind) => {
    if (!currentGuest || currentGuest.id === 'anonymous') return; // silently no-op
    storageService.togglePhotoReaction(photoId, reaction, currentGuest.id);
  }, [currentGuest]);

  const addComment = useCallback((photoId: string, commentText: string) => {
    if (!currentGuest || currentGuest.id === 'anonymous') return;
    storageService.addComment(photoId, currentGuest.id, currentGuest.name, commentText);
  }, [currentGuest]);

  const setPhotoStatus = useCallback((photoId: string, status: PhotoStatus) => {
    storageService.setPhotoStatus(photoId, status);
  }, []);

  const deletePhoto = useCallback((photoId: string) => {
    storageService.deletePhoto(photoId);
  }, []);

  const addQuest = (title: string, description: string, iconName?: string, points?: number) => {
    return storageService.addQuest(title, description, iconName, points);
  };

  const deleteQuest = (questId: string) => storageService.deleteQuest(questId);

  const completeQuest = useCallback((questId: string) => {
    if (!currentGuest || currentGuest.id === 'anonymous') return;
    storageService.completeQuest(questId, currentGuest.id);
  }, [currentGuest]);

  const addAudioEntry = (audioBlob: Blob, durationSeconds: number, note?: string, mimeType?: string) => {
    return storageService.addAudioEntry(audioBlob, durationSeconds, note, mimeType);
  };

  const resetDefaults = useCallback(() => {
    storageService.resetToDefaults();
  }, []);

  // M3 — recomputed on every render otherwise, including the many renders
  // driven by incoming WebSocket traffic that do not touch `photos` at all.
  const pendingPhotosCount = useMemo(
    () => photos.filter((p) => p.status === 'pending').length,
    [photos]
  );

  const dismissSyncErrorCb = useCallback(() => setSyncError(null), []);

  return (
    <AppContext.Provider
      value={useMemo(
        () => ({
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
          isSyncingAlbum,
          eventError,
          eventErrorKind,
          missingSlug,
          retryEventLoad,
          queuedUploadCount,
          isNetworkOnline,
          pendingPhotosCount,
          syncError,
          dismissSyncError: dismissSyncErrorCb,

          navigateView,
          navigateGuestTab,
          loadEventBySlug,
          openSignedInAlbum,
          ensureOwnAlbum,
          updateEvent,
          upgradePlanTier,
          setCover,
          removeCover,
          refreshEventDetails,
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
          completeQuest,
          addAudioEntry,
          resetDefaults,
        }),
        // The handlers below are stable module-level delegations to
        // storageService; only the state they close over actually varies.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [
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
          isSyncingAlbum,
          eventError,
          eventErrorKind,
          missingSlug,
          retryEventLoad,
          queuedUploadCount,
          isNetworkOnline,
          pendingPhotosCount,
          syncError,
        ]
      )}
    >
      {children}
    </AppContext.Provider>
  );
};

export function useApp(): AppContextType {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
