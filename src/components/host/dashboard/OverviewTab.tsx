/**
 * The album's settings: plan usage, theme, the guest-facing toggles, the
 * danger zone, and the branding and date fields.
 *
 * Split out of `HostDashboard.tsx` (986 lines, past the project's 800-line
 * ceiling). The markup is unchanged; it reads its state from the dashboard
 * context instead of closing over the parent's scope.
 */

import React from 'react';
import { Settings, Shield, Trophy, Camera, Users } from 'lucide-react';
import { i18n } from '../../../i18n';
import { THEMES } from '../../../config/themes';
import { transliterateBg } from '../../../utils/transliterate';
import { router } from '../../../router';
import { StorageMeter } from '../StorageMeter';
import { maskDateInput, maskTimeInput } from './dateFields';
import { ThemePalette } from '../../../types';
import { useHostDashboard } from './context';

export const OverviewTab: React.FC = () => {
  const {
    commitEventDateTime, deleteConfirmText, event, eventDateText, eventTimeText,
    guests, handleDeleteEvent, handleResetGuestSessions, hostNameDraft,
    isDeletingEvent, isResettingGuests, onOpenPricing, onUpdateEvent,
    pendingPhotos, photos, quests, setDeleteConfirmText, setEventDateText,
    setEventTimeText, setHostNameDraft, setSlugDraft, setTitleDraft,
    setVenueNameDraft, setWelcomeMessageDraft, slugDraft, titleDraft,
    venueNameDraft, welcomeMessageDraft,
  } = useHostDashboard();

  return (
    <div className="space-y-6">
  
      {/* Plan usage: both numbers are enforced server-side, so the host
          needs to see them before an upload is refused. */}
      <StorageMeter eventId={event.id} onOpenPricing={onOpenPricing} />

      {/* Quick Metrics Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="p-4 rounded-2xl bg-noir-800/90 border border-cream-400/10">
          <div className="flex items-center justify-between text-cream-400 text-xs mb-1">
            <span>{i18n.t('hero.moments_captured')}</span>
            <Camera className="w-4 h-4 text-gold-400" />
          </div>
          <div className="font-serif text-2xl font-bold text-cream-100">{photos.length}</div>
        </div>

        <div className="p-4 rounded-2xl bg-noir-800/90 border border-cream-400/10">
          <div className="flex items-center justify-between text-cream-400 text-xs mb-1">
            <span>{i18n.t('hero.guests_joined')}</span>
            <Users className="w-4 h-4 text-gold-400" />
          </div>
          <div className="font-serif text-2xl font-bold text-cream-100">{guests.length}</div>
        </div>

        <div className="p-4 rounded-2xl bg-noir-800/90 border border-cream-400/10">
          <div className="flex items-center justify-between text-cream-400 text-xs mb-1">
            <span>{i18n.t('ui.host_dashboard.2')}</span>
            <Shield className="w-4 h-4 text-rosewood-400" />
          </div>
          <div className="font-serif text-2xl font-bold text-cream-100">{pendingPhotos.length}</div>
        </div>

        <div className="p-4 rounded-2xl bg-noir-800/90 border border-cream-400/10">
          <div className="flex items-center justify-between text-cream-400 text-xs mb-1">
            <span>{i18n.t('hero.quests_completed')}</span>
            <Trophy className="w-4 h-4 text-gold-400" />
          </div>
          <div className="font-serif text-2xl font-bold text-cream-100">
            {quests.reduce((acc, q) => acc + (q.completedByGuestIds.length > 0 ? 1 : 0), 0)} / {quests.length}
          </div>
        </div>
      </div>

      {/* Event Configuration & Toggles */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
    
        {/* Theme & Controls */}
        <div className="bg-noir-800/90 rounded-3xl p-6 border border-cream-400/10 space-y-5">
          <h4 className="font-serif text-lg font-bold text-cream-100 flex items-center gap-2">
            <Settings className="w-5 h-5 text-gold-400" />
            <span>{i18n.t('host.settings')}</span>
          </h4>

          {/* Theme Palette Selector */}
          <div>
            <label className="block text-xs font-semibold text-cream-300 mb-2">
              {i18n.t('ui.host_dashboard.3')}
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {Object.keys(THEMES).map((themeKey) => {
                const t = THEMES[themeKey as ThemePalette];
                const isSelected = event.themePalette === themeKey;
                return (
                  <button
                    key={themeKey}
                    type="button"
                    onClick={() => onUpdateEvent({ themePalette: themeKey as ThemePalette })}
                    className={`p-2 rounded-xl border flex items-center gap-2 text-left transition-all ${
                      isSelected
                        ? 'border-gold-400 bg-gold-400/10 shadow-glow'
                        : 'border-cream-400/10 bg-noir-900 hover:border-cream-400/30'
                    }`}
                  >
                    <div
                      className="w-4 h-4 rounded-full border border-white/20 shrink-0"
                      style={{ backgroundColor: t.accent }}
                    />
                    <span className="text-xs text-cream-200 truncate">{i18n.t(t.name)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Moderation Mode Toggle */}
          <div className="flex items-center justify-between p-3.5 rounded-2xl bg-noir-900/60 border border-cream-400/10">
            <div>
              <span className="text-xs font-semibold text-cream-100 block">
                {i18n.t('ui.host_dashboard.4')}
              </span>
              <span className="text-[11px] text-cream-400/70">
                {i18n.t('ui.host_dashboard.5')}
              </span>
            </div>
            <button
              onClick={() => onUpdateEvent({ isModerationEnabled: !event.isModerationEnabled })}
              className={`w-12 h-6 rounded-full transition-colors relative p-0.5 ${
                event.isModerationEnabled ? 'bg-gold-400' : 'bg-noir-700'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-noir-900 transition-transform ${
                  event.isModerationEnabled ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Danger zone (D2) — the only way to remove an album, and the
              app's GDPR erasure path. Kept visually separate from the
              ordinary settings above it. */}
          <div className="p-3.5 rounded-2xl bg-rosewood-950/30 border border-rosewood-500/30 space-y-2.5">
            <div>
              <span className="text-xs font-bold text-rosewood-200 block uppercase tracking-wider">
                {i18n.t('host.danger_zone')}
              </span>
              <span className="text-[11px] text-cream-400/70 block mt-0.5">
                {i18n.t('host.delete_event_hint')}
              </span>
            </div>
            <label className="block text-[11px] text-cream-300/80">
              {i18n.t('host.delete_event_confirm', { slug: event.slug })}
            </label>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={event.slug}
              aria-label={i18n.t('host.delete_event')}
              className="w-full px-3 py-1.5 rounded-xl bg-noir-900 border border-rosewood-500/30 text-cream-100 text-xs placeholder:text-cream-400/30 focus:outline-none focus:border-rosewood-400"
            />
            <button
              type="button"
              disabled={isDeletingEvent || deleteConfirmText !== event.slug}
              onClick={handleDeleteEvent}
              className="w-full px-3.5 py-2 rounded-xl bg-rosewood-600 text-white text-xs font-bold hover:bg-rosewood-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {i18n.t('host.delete_event')}
            </button>
          </div>

          {/* Guest session reset (M10) — the only way to revoke a guest
              token, which is otherwise valid for the life of the album. */}
          <div className="flex items-center justify-between p-3.5 rounded-2xl bg-noir-900/60 border border-cream-400/10">
            <div className="pr-3">
              <span className="text-xs font-semibold text-cream-100 block">
                {i18n.t('host.reset_guest_sessions')}
              </span>
              <span className="text-[11px] text-cream-400/70">
                {i18n.t('host.reset_guest_sessions_hint')}
              </span>
            </div>
            <button
              type="button"
              disabled={isResettingGuests}
              onClick={handleResetGuestSessions}
              className="shrink-0 px-3.5 py-1.5 rounded-xl border border-rosewood-500/40 text-rosewood-200 bg-rosewood-950/40 text-[11px] font-bold hover:bg-rosewood-950/70 disabled:opacity-50 transition-colors"
            >
              {i18n.t('host.reset_guest_sessions')}
            </button>
          </div>

          {/* Public Showcase Opt-In (H6) — off by default; the album is
              private until the couple says otherwise. */}
          <div className="flex items-center justify-between p-3.5 rounded-2xl bg-noir-900/60 border border-cream-400/10">
            <div className="pr-3">
              <span className="text-xs font-semibold text-cream-100 block">
                {i18n.t('host.public_showcase_label')}
              </span>
              <span className="text-[11px] text-cream-400/70">
                {i18n.t('host.public_showcase_hint')}
              </span>
            </div>
            <button
              aria-label={i18n.t('host.public_showcase_label')}
              aria-pressed={!!event.isPublic}
              onClick={() => onUpdateEvent({ isPublic: !event.isPublic })}
              className={`shrink-0 w-12 h-6 rounded-full transition-colors relative p-0.5 ${
                event.isPublic ? 'bg-gold-400' : 'bg-noir-700'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-noir-900 transition-transform ${
                  event.isPublic ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Disposable Camera Mode Toggle */}
          <div className="flex items-center justify-between p-3.5 rounded-2xl bg-noir-900/60 border border-cream-400/10">
            <div>
              <span className="text-xs font-semibold text-cream-100 block">
                {i18n.t('host.disposable_mode_label')}
              </span>
              <span className="text-[11px] text-cream-400/70">
                {i18n.t('ui.host_dashboard.6')}
              </span>
            </div>
            <button
              onClick={() => onUpdateEvent({ isDisposableMode: !event.isDisposableMode })}
              className={`w-12 h-6 rounded-full transition-colors relative p-0.5 ${
                event.isDisposableMode ? 'bg-gold-400' : 'bg-noir-700'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-noir-900 transition-transform ${
                  event.isDisposableMode ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Photo Limit */}
          <div>
            <label className="flex justify-between text-xs font-semibold text-cream-200 mb-1.5">
              <span>{i18n.t('ui.host_dashboard.7')}</span>
              <span className="text-gold-400">
                {i18n.t('host.photos_count', { count: event.maxPhotosPerGuest ?? 0 })}
              </span>
            </label>
            <input
              type="range"
              min="10"
              max="150"
              step="5"
              value={event.maxPhotosPerGuest}
              onChange={(e) => onUpdateEvent({ maxPhotosPerGuest: Number(e.target.value) })}
              className="w-full accent-gold-400"
            />
          </div>
        </div>

        {/* Event Branding Details */}
        <div className="bg-noir-800/90 rounded-3xl p-6 border border-cream-400/10 space-y-4">
          <h4 className="font-serif text-lg font-bold text-cream-100 flex items-center gap-2">
            <Settings className="w-5 h-5 text-gold-400" />
            <span>{i18n.t('ui.host_dashboard.8')}</span>
          </h4>

          {/* Couple / Host Names */}
          <div>
            <label className="block text-xs font-semibold text-cream-300 mb-1">
              {i18n.t('ui.host_dashboard.9')}
            </label>
            <input
              type="text"
              value={hostNameDraft}
              onChange={(e) => setHostNameDraft(e.target.value)}
              placeholder={i18n.t('host.hosts_example')}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
            />
          </div>

          {/* Event Title */}
          <div>
            <label className="block text-xs font-semibold text-cream-300 mb-1">
              {i18n.t('ui.host_dashboard.10')}
            </label>
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              placeholder={i18n.t('host.title_example')}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
            />
          </div>

          {/* Event Slug URL */}
          <div>
            <label className="flex justify-between text-xs font-semibold text-cream-300 mb-1">
              <span>{i18n.t('ui.host_dashboard.11')}</span>
              <span className="text-gold-400 font-mono text-[10px]">/e/{slugDraft}</span>
            </label>
            <input
              type="text"
              value={slugDraft}
              onChange={(e) => {
                const raw = e.target.value;
                const customSlug = transliterateBg(raw)
                  .toLowerCase()
                  .replace(/[^a-z0-9-]/g, '-')
                  .replace(/-+/g, '-');
                // The URL bar preview updates live — it's local and free.
                // The server write is what's debounced. replace: true
                // (FE-07) so a handful of keystrokes doesn't push a
                // history entry per character — router.navigate always
                // pushed, unlike this typing-preview case needs.
                setSlugDraft(customSlug);
                router.navigate('host', customSlug, undefined, { replace: true });
              }}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-gold-300 font-mono focus:outline-none focus:border-gold-400"
            />
          </div>

          {/* Event Date & Time Picker — plain text inputs, not a native
              datetime-local: that widget renders in whatever format the
              device's OS locale dictates (MM/DD/YYYY, AM/PM on an en-US
              phone) regardless of this app's own language setting. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-cream-300 mb-1">
                {i18n.t('ui.host_dashboard.12')}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="ДД.ММ.ГГГГ"
                  maxLength={10}
                  value={eventDateText}
                  onChange={(e) => setEventDateText(maskDateInput(e.target.value))}
                  onBlur={() => commitEventDateTime(eventDateText, eventTimeText)}
                  className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400 font-mono"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="ЧЧ:ММ"
                  maxLength={5}
                  value={eventTimeText}
                  onChange={(e) => setEventTimeText(maskTimeInput(e.target.value))}
                  onBlur={() => commitEventDateTime(eventDateText, eventTimeText)}
                  className="w-24 px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400 font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-cream-300 mb-1">
                {i18n.t('ui.host_dashboard.13')}
              </label>
              <input
                type="text"
                value={venueNameDraft}
                onChange={(e) => setVenueNameDraft(e.target.value)}
                placeholder={i18n.t('host.venue_example')}
                className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
              />
            </div>
          </div>

          {/* Welcome Note to Guests */}
          <div>
            <label className="block text-xs font-semibold text-cream-300 mb-1">
              {i18n.t('ui.host_dashboard.14')}
            </label>
            <textarea
              value={welcomeMessageDraft}
              onChange={(e) => setWelcomeMessageDraft(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400 resize-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
