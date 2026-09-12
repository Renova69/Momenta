/**
 * The host's control room for one album.
 *
 * This file was 986 lines, past the 800-line ceiling in the project's coding
 * standards. It now owns the dashboard's state and the actions that change it,
 * and renders the tab shell; each tab's markup lives in `./dashboard/`.
 *
 * **State stayed here on purpose.** The tabs read it through
 * `HostDashboardProvider` rather than props — the Overview tab alone needs
 * about thirty values — but nothing below the provider holds state of its own,
 * so there is still exactly one place where any of it is written.
 *
 * Tier gates stay here too, next to the tab they guard, so what a plan unlocks
 * is readable in one place instead of spread across six files. They are a UI
 * affordance only: the server re-checks every one of them.
 */

import React, { useState, useEffect } from 'react';
import { ModerationQueue } from './ModerationQueue';
import { QRCanvasStudio } from './QRCanvasStudio';
import { PhotographerIngestPanel } from './PhotographerIngestPanel';
import { eventsApi } from '../../api/eventsApi';
import { i18n } from '../../i18n';
import { isFeatureUnlocked } from '../../config/tierGating';
import { LockedFeatureCard } from '../common/LockedFeatureBadge';
import { ENV } from '../../config/env';
import { useDebouncedField } from '../../hooks/useDebouncedField';
import {
  WeddingEvent,
  Guest,
  Photo,
  ScavengerQuest,
  AudioGuestbookEntry,
  QRCanvasConfig,
  PhotoStatus,
} from '../../types';
import { HostDashboardProvider, HostTab, HostDashboardValue } from './dashboard/context';
import { formatDateDDMMYYYY, formatTime24h, parseDateAndTime } from './dashboard/dateFields';
import { TabNav } from './dashboard/TabNav';
import { OverviewTab } from './dashboard/OverviewTab';
import { QuestsTab } from './dashboard/QuestsTab';
import { ExportTab } from './dashboard/ExportTab';

interface HostDashboardProps {
  event: WeddingEvent;
  guests: Guest[];
  photos: Photo[];
  quests: ScavengerQuest[];
  audioEntries: AudioGuestbookEntry[];
  qrConfig: QRCanvasConfig;
  onUpdateEvent: (updates: Partial<WeddingEvent>) => void;
  onUpdateQRConfig: (updates: Partial<QRCanvasConfig>) => void;
  onSetPhotoStatus: (photoId: string, status: PhotoStatus) => void;
  onDeletePhoto: (photoId: string) => void;
  onAddQuest: (title: string, description: string, iconName?: string, points?: number) => void;
  onResetData: () => void;
  onOpenPricing?: () => void;
}

export const HostDashboard: React.FC<HostDashboardProps> = ({
  event,
  guests,
  photos,
  quests,
  audioEntries,
  qrConfig,
  onUpdateEvent,
  onUpdateQRConfig,
  onSetPhotoStatus,
  onDeletePhoto,
  onAddQuest,
  onResetData,
  onOpenPricing,
}) => {
  // M10 — revoking guest sessions is destructive to guest *identities* (their
  // photos stay, their link to them does not), so it asks first and reports
  // exactly how many sessions it ended rather than succeeding silently.
  const [isResettingGuests, setIsResettingGuests] = useState(false);

  // D2 — the erasure path. Irreversible, so it asks the host to type the
  // album's own address back before the button does anything, the same way
  // the server checks it. A confirm() dialog alone is one misclick.
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeletingEvent, setIsDeletingEvent] = useState(false);

  const handleDeleteEvent = async () => {
    if (!event?.id || deleteConfirmText !== event.slug) return;

    setIsDeletingEvent(true);
    try {
      const { photosDeleted } = await eventsApi.remove(event.id, deleteConfirmText);
      window.alert(i18n.t('host.delete_event_done', { count: photosDeleted }));
      window.location.href = '/';
    } catch (err) {
      window.alert(err instanceof Error ? err.message : i18n.t('common.save_failed'));
      setIsDeletingEvent(false);
    }
  };

  const handleResetGuestSessions = async () => {
    if (!event?.id) return;
    if (!window.confirm(i18n.t('host.reset_guest_sessions_confirm'))) return;

    setIsResettingGuests(true);
    try {
      const { guestsReset } = await eventsApi.resetGuestSessions(event.id);
      window.alert(i18n.t('host.reset_guest_sessions_done', { count: guestsReset }));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : i18n.t('common.save_failed'));
    } finally {
      setIsResettingGuests(false);
    }
  };

  const [activeTab, setActiveTab] = useState<HostTab>('overview');
  const [newQuestTitle, setNewQuestTitle] = useState('');
  const [newQuestDesc, setNewQuestDesc] = useState('');
  const [newQuestPoints, setNewQuestPoints] = useState(15);
  const [newQuestIcon, setNewQuestIcon] = useState('camera');
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Local, responsive drafts — committed to the server only after typing
  // pauses, instead of one PUT request per keystroke (P3).
  const [hostNameDraft, setHostNameDraft] = useDebouncedField(event.hostName, (newName) => {
    const isDefaultTitle = !event.title || event.title.startsWith(i18n.t('host.wedding_of'));
    onUpdateEvent({
      hostName: newName,
      title: isDefaultTitle ? i18n.t('host.wedding_of_name', { name: newName }) : event.title,
    });
  });
  const [titleDraft, setTitleDraft] = useDebouncedField(event.title, (newTitle) =>
    onUpdateEvent({ title: newTitle })
  );
  const [slugDraft, setSlugDraft] = useDebouncedField(event.slug, (newSlug) =>
    onUpdateEvent({ slug: newSlug })
  );
  const [venueNameDraft, setVenueNameDraft] = useDebouncedField(event.venueName, (newVenue) =>
    onUpdateEvent({ venueName: newVenue })
  );
  const [welcomeMessageDraft, setWelcomeMessageDraft] = useDebouncedField(event.welcomeMessage, (newMsg) =>
    onUpdateEvent({ welcomeMessage: newMsg })
  );

  const [eventDateText, setEventDateText] = useState(() => formatDateDDMMYYYY(event.eventDate));
  const [eventTimeText, setEventTimeText] = useState(() => formatTime24h(event.eventDate));
  useEffect(() => {
    setEventDateText(formatDateDDMMYYYY(event.eventDate));
    setEventTimeText(formatTime24h(event.eventDate));
  }, [event.eventDate]);

  const commitEventDateTime = (nextDateText: string, nextTimeText: string) => {
    const parsed = parseDateAndTime(nextDateText, nextTimeText);
    // FE-05: the slug is the public URL — already shared, printed on QR
    // codes, texted to guests. Changing the ceremony time must never
    // silently change it too.
    if (parsed) {
      onUpdateEvent({ eventDate: parsed.toISOString() });
    }
  };

  const pendingPhotos = photos.filter((p) => p.status === 'pending');
  const currentTier = event.planTier || 'free';

  const handleExportAll = () => {
    const backupData = {
      event,
      guests,
      photos,
      quests,
      audioEntries,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${event.slug}-full-data-export.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Download the full-resolution archive.
   *
   * The browser streams it straight to disk via a short-lived signed link.
   * Fetching into a Blob first would hold the whole archive in memory — with
   * originals retained that is gigabytes for a real wedding, and it simply fails
   * on a phone.
   */
  const handleDownloadZip = async () => {
    setIsExportingZip(true);
    setExportError(null);
    try {
      const ticket = await eventsApi.requestExportTicket(event.id);
      const apiHost = ENV.API_URL?.replace(/\/+$/, '') || '';
      const url =
        `${apiHost}/api/events/${event.id}/export-zip` +
        `?token=${encodeURIComponent(ticket.token)}`;

      const a = document.createElement('a');
      a.href = url;
      a.download = ticket.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      console.error('ZIP export failed:', err);
      // Surface what the server actually said — a tier refusal is not a session problem.
      setExportError(err instanceof Error ? err.message : i18n.t('host.zip_failed'));
    } finally {
      setIsExportingZip(false);
    }
  };

  const handleCreateQuest = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuestTitle.trim()) return;
    onAddQuest(newQuestTitle, newQuestDesc, newQuestIcon, newQuestPoints);
    setNewQuestTitle('');
    setNewQuestDesc('');
  };
  const dashboard: HostDashboardValue = {
    event, guests, photos, quests, audioEntries, qrConfig,
    onUpdateEvent, onUpdateQRConfig, onSetPhotoStatus, onDeletePhoto,
    onAddQuest, onResetData, onOpenPricing,
    pendingPhotos, currentTier,
    activeTab, setActiveTab,
    hostNameDraft, setHostNameDraft,
    titleDraft, setTitleDraft,
    slugDraft, setSlugDraft,
    venueNameDraft, setVenueNameDraft,
    welcomeMessageDraft, setWelcomeMessageDraft,
    eventDateText, setEventDateText,
    eventTimeText, setEventTimeText,
    commitEventDateTime,
    isResettingGuests, handleResetGuestSessions,
    deleteConfirmText, setDeleteConfirmText,
    isDeletingEvent, handleDeleteEvent,
    newQuestTitle, setNewQuestTitle,
    newQuestDesc, setNewQuestDesc,
    newQuestPoints, setNewQuestPoints,
    newQuestIcon, setNewQuestIcon,
    handleCreateQuest,
    isExportingZip, exportError, handleExportAll, handleDownloadZip,
  };

  return (
    <HostDashboardProvider value={dashboard}>
      <div className="space-y-6 sm:space-y-8 animate-fade-in max-w-6xl mx-auto">
        <TabNav />

        {/* 1. OVERVIEW & EVENT SETTINGS TAB */}
        {activeTab === 'overview' && <OverviewTab />}

        {/* 2. MODERATION QUEUE TAB */}
        {activeTab === 'moderation' && (
          !isFeatureUnlocked(currentTier, 'photo_moderation') ? (
            <LockedFeatureCard feature="photo_moderation" onOpenPricing={onOpenPricing || (() => {})} />
          ) : (
            <ModerationQueue
              photos={photos}
              onSetStatus={onSetPhotoStatus}
              onDeletePhoto={onDeletePhoto}
            />
          )
        )}

        {/* 3. QR CANVAS TAB */}
        {activeTab === 'canvas' && (
          !isFeatureUnlocked(currentTier, 'qr_print_studio') ? (
            <LockedFeatureCard feature="qr_print_studio" onOpenPricing={onOpenPricing || (() => {})} />
          ) : (
            <QRCanvasStudio
              event={event}
              config={qrConfig}
              onUpdateConfig={onUpdateQRConfig}
            />
          )
        )}

        {/* 4. QUEST BUILDER TAB */}
        {activeTab === 'quests' && (
          !isFeatureUnlocked(currentTier, 'scavenger_quests') ? (
            <LockedFeatureCard feature="scavenger_quests" onOpenPricing={onOpenPricing || (() => {})} />
          ) : (
            <QuestsTab />
          )
        )}

        {/* 5. EXPORT & ARCHIVE TAB */}
        {activeTab === 'export' && (
          !isFeatureUnlocked(currentTier, 'zip_export') ? (
            <LockedFeatureCard feature="zip_export" onOpenPricing={onOpenPricing || (() => {})} />
          ) : (
            <ExportTab />
          )
        )}

        {/* 6. PHOTOGRAPHER INGEST TAB */}
        {activeTab === 'ingest' && (
          <PhotographerIngestPanel event={event} />
        )}
      </div>
    </HostDashboardProvider>
  );
};
