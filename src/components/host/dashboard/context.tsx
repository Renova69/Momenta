/**
 * Shared state for the host dashboard's tabs.
 *
 * `HostDashboard.tsx` was 986 lines, past the 800-line ceiling in the project's
 * coding standards. Its tabs are now separate components, and they read what
 * they need from here.
 *
 * Context rather than props: the Overview tab alone needs about thirty values,
 * and `rules/ecc/web/patterns.md` calls for exactly this shape — the parent
 * owns the state, children consume it via context — instead of drilling a prop
 * list that long.
 *
 * `HostDashboard` remains the only writer. Nothing here holds state of its own;
 * it is a transport, so the tabs stay as easy to reason about as they were when
 * they were inline JSX in one function.
 */

import React, { createContext, useContext } from 'react';
import {
  WeddingEvent,
  Guest,
  Photo,
  ScavengerQuest,
  AudioGuestbookEntry,
  QRCanvasConfig,
  PhotoStatus,
  PlanTier,
} from '../../../types';

export type HostTab = 'overview' | 'moderation' | 'canvas' | 'quests' | 'export' | 'ingest';

export interface HostDashboardValue {
  // ——— Data handed down from the app ———
  event: WeddingEvent;
  guests: Guest[];
  photos: Photo[];
  quests: ScavengerQuest[];
  audioEntries: AudioGuestbookEntry[];
  qrConfig: QRCanvasConfig;

  // ——— Callbacks into the app ———
  onUpdateEvent: (updates: Partial<WeddingEvent>) => void;
  onUpdateQRConfig: (updates: Partial<QRCanvasConfig>) => void;
  onSetPhotoStatus: (photoId: string, status: PhotoStatus) => void;
  onDeletePhoto: (photoId: string) => void;
  onAddQuest: (title: string, description: string, iconName?: string, points?: number) => void;
  onResetData: () => void;
  onOpenPricing?: () => void;

  // ——— Derived once, read by several tabs ———
  /** Photos awaiting host approval; drives the moderation tab's badge count. */
  pendingPhotos: Photo[];
  /** The album's effective plan, which every feature gate below is checked against. */
  currentTier: PlanTier;

  // ——— Navigation ———
  activeTab: HostTab;
  setActiveTab: (tab: HostTab) => void;

  // ——— Debounced text drafts (P3) ———
  // Local and responsive; committed to the server only after typing pauses,
  // instead of one PUT per keystroke.
  hostNameDraft: string;
  setHostNameDraft: (value: string) => void;
  titleDraft: string;
  setTitleDraft: (value: string) => void;
  slugDraft: string;
  setSlugDraft: (value: string) => void;
  venueNameDraft: string;
  setVenueNameDraft: (value: string) => void;
  welcomeMessageDraft: string;
  setWelcomeMessageDraft: (value: string) => void;

  // ——— Custom date/time fields ———
  eventDateText: string;
  setEventDateText: (value: string) => void;
  eventTimeText: string;
  setEventTimeText: (value: string) => void;
  commitEventDateTime: (nextDateText: string, nextTimeText: string) => void;

  // ——— Destructive actions, each with its own in-flight flag ———
  isResettingGuests: boolean;
  handleResetGuestSessions: () => Promise<void>;
  deleteConfirmText: string;
  setDeleteConfirmText: (value: string) => void;
  isDeletingEvent: boolean;
  handleDeleteEvent: () => Promise<void>;

  // ——— Quest builder ———
  newQuestTitle: string;
  setNewQuestTitle: (value: string) => void;
  newQuestDesc: string;
  setNewQuestDesc: (value: string) => void;
  newQuestPoints: number;
  setNewQuestPoints: (value: number) => void;
  newQuestIcon: string;
  setNewQuestIcon: (value: string) => void;
  handleCreateQuest: (e: React.FormEvent) => void;

  // ——— Export ———
  isExportingZip: boolean;
  exportError: string | null;
  handleExportAll: () => void;
  handleDownloadZip: () => Promise<void>;
}

const HostDashboardContext = createContext<HostDashboardValue | null>(null);

export const HostDashboardProvider = HostDashboardContext.Provider;

/**
 * Read the dashboard's shared state.
 *
 * Throws rather than returning null when used outside the provider: a tab
 * rendered in the wrong place would otherwise fail later with an opaque
 * "cannot read property of null" from somewhere deep in the JSX.
 */
export function useHostDashboard(): HostDashboardValue {
  const value = useContext(HostDashboardContext);
  if (!value) {
    throw new Error('useHostDashboard must be used inside <HostDashboardProvider>');
  }
  return value;
}
