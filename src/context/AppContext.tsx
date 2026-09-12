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
  isLoadingEvent: boolean;
  eventError: string | null;
  queuedUploadCount: number;
  isNetworkOnline: boolean;
  pendingPhotosCount: number;
  syncError: string | null;
  dismissSyncError: () => void;

  // Navigation
  navigateView: (view: ActiveView, tab?: 'feed' | 'quests' | 'audio') => void;
  navigateGuestTab: (tab: 'feed' | 'quests' | 'audio') => void;
  loadEventBySlug: (slug: string) => Promise<WeddingEvent | null>;

  // Actions
  updateEvent: (updates: Partial<WeddingEvent>) => void;
  upgradePlanTier: (tier: PlanTier) => Promise<void>;
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
  const [isLoadingEvent, setIsLoadingEvent] = useState<boolean>(false);
  const [eventError, setEventError] = useState<string | null>(null);

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
      setIsLoadingEvent(true);
      storageService.loadEventBySlug(initialRoute.slug)
        .then((res) => {
          if (!res) setEventError(`Event not found: ${initialRoute.slug}`);
          else setEventError(null);
        })
        .catch((e) => setEventError(e.message))
        .finally(() => setIsLoadingEvent(false));
    }

    // 2. Storage service subscriber
    const unsubStorage = storageService.subscribe(() => {
      setEvent(storageService.getEvent());
      setGuests(storageService.getGuests());
      setCurrentGuest(storageService.getCurrentGuest());
      setPhotos(storageService.getPhotos());
      setQuests(storageService.getQuests());
      setAudioEntries(storageService.getAudioEntries());
      setQRConfig(storageService.getQRCanvasConfig());
    });

    // 3. Router subscriber
    const unsubRouter = router.subscribe((route: RouteState) => {
      setActiveView(route.view);
      if (route.subTab) setActiveGuestTab(route.subTab);
      if (route.slug && route.slug !== storageService.getEvent().slug) {
        setIsLoadingEvent(true);
        storageService.loadEventBySlug(route.slug)
          .then((res) => {
            if (!res) setEventError(`Event not found: ${route.slug}`);
            else setEventError(null);
          })
          .catch((e) => setEventError(e.message))
          .finally(() => setIsLoadingEvent(false));
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

    return () => {
      unsubStorage();
      unsubRouter();
      unsubQueue();
      unsubI18n();
      unsubErrors();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateView = (view: ActiveView, tab?: 'feed' | 'quests' | 'audio') => {
    setEventError(null);
    setActiveView(view);
    if (tab) setActiveGuestTab(tab);
    const currentSlug = router.getRoute().slug;
    router.navigate(view, currentSlug, tab || activeGuestTab);
  };

  const navigateGuestTab = (tab: 'feed' | 'quests' | 'audio') => {
    setEventError(null);
    setActiveGuestTab(tab);
    const currentSlug = router.getRoute().slug;
    router.navigate('guest', currentSlug, tab);
  };

  const loadEventBySlug = async (slug: string): Promise<WeddingEvent | null> => {
    setIsLoadingEvent(true);
    try {
      const loaded = await storageService.loadEventBySlug(slug);
      if (!loaded) {
        setEventError(`Event not found: ${slug}`);
      } else {
        setEventError(null);
        router.navigate('guest', slug, 'feed');
      }
      return loaded;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setEventError(errorMsg || 'Error loading event');
      return null;
    } finally {
      setIsLoadingEvent(false);
    }
  };

  const updateEvent = useCallback((updates: Partial<WeddingEvent>) => {
    storageService.updateEvent(updates);
  }, []);

  const upgradePlanTier = useCallback(async (tier: PlanTier) => {
    return storageService.upgradePlanTier(tier);
  }, []);

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
          eventError,
          queuedUploadCount,
          isNetworkOnline,
          pendingPhotosCount,
          syncError,
          dismissSyncError: dismissSyncErrorCb,

          navigateView,
          navigateGuestTab,
          loadEventBySlug,
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
          eventError,
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
