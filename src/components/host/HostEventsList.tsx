import React, { useId, useState, useEffect } from 'react';
import { WeddingEvent } from '../../types';
import { generateEventSlug } from '../../utils/transliterate';
import { formatEuDate } from '../../utils/date';
import { i18n } from '../../i18n';
import { eventsApi } from '../../api/eventsApi';
import {
  Calendar,
  MapPin,
  Plus,
  ArrowRight,
  X
} from 'lucide-react';

interface HostEventsListProps {
  isOpen: boolean;
  onClose: () => void;
  currentEvent: WeddingEvent;
  onSelectEvent: (event: WeddingEvent) => void;
  onCreateEvent: (newEvent: Partial<WeddingEvent>) => Promise<void>;
  onOpenPricing: () => void;
}

/** How far ahead the form suggests a new celebration. */
const SUGGESTED_DAYS_AHEAD = 90;

/**
 * The date the form starts with, as a datetime-local value: some months
 * ahead, late afternoon, local time. It was a fixed 18 September 2026, which
 * every host since that day was offered as a date already past (N-90).
 */
function suggestedEventDate(): string {
  const when = new Date();
  when.setDate(when.getDate() + SUGGESTED_DAYS_AHEAD);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T16:30`;
}

export const HostEventsList: React.FC<HostEventsListProps> = ({
  isOpen,
  onClose,
  currentEvent,
  onSelectEvent,
  onCreateEvent,
}) => {
  // One id per field, so each visible label points at the control it names.
  const fieldIds = useId();
  const [isCreating, setIsCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [hostName, setHostName] = useState('');
  const [eventDate, setEventDate] = useState(suggestedEventDate);
  const [venueName, setVenueName] = useState('');
  const [events, setEvents] = useState<WeddingEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    setIsLoading(true);
    setErrorMsg('');
    eventsApi.listMine()
      .then((mine) => {
        if (cancelled) return;
        // N-116 — only what the server says is this host's. The album open in
        // this browser was added when missing, and it can be one the host does
        // not own: the demo wedding was listed as theirs and "Активна".
        setEvents(Array.isArray(mine) ? mine : []);
      })
      .catch((err) => {
        if (!cancelled) setErrorMsg(i18n.t('events.load_failed') + ((err instanceof Error ? err.message : '') || ''));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, currentEvent]);

  if (!isOpen) return null;

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hostName.trim()) return;
    // N-90 — an empty date has no ISO form: toISOString threw, and the
    // submit failed with nothing on screen to say why.
    const when = new Date(eventDate);
    if (!eventDate || Number.isNaN(when.getTime())) {
      setErrorMsg(i18n.t('events.date_required'));
      return;
    }

    const slug = generateEventSlug(hostName, eventDate);

    const newEvent: Partial<WeddingEvent> = {
      title: title.trim() || i18n.t('host.wedding_of_name', { name: hostName }),
      hostName: hostName.trim(),
      slug,
      eventDate: when.toISOString(),
      venueName: venueName.trim() || i18n.t('events.default_venue'),
      themePalette: 'champagne_gold',
    };

    setIsSubmitting(true);
    setErrorMsg('');
    try {
      await onCreateEvent(newEvent);
      onClose();
    } catch (err) {
      setErrorMsg((err instanceof Error ? err.message : '') || i18n.t('events.create_failed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-2xl bg-noir-900 rounded-3xl border border-gold-400/30 shadow-2xl p-6 sm:p-8 overflow-hidden max-h-[90vh] flex flex-col">
        
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full bg-noir-800 text-cream-300 hover:text-white"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="font-serif text-2xl font-bold text-cream-100 flex items-center gap-2">
              <Calendar className="w-6 h-6 text-gold-400" />
              <span>{i18n.t('host.my_events')}</span>
            </h3>
            <p className="text-xs text-cream-400/70">
              {i18n.t('host.my_events_desc')}
            </p>
          </div>

          <button
            onClick={() => setIsCreating(!isCreating)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gold-400 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110"
          >
            <Plus className="w-4 h-4" />
            <span>{isCreating ? i18n.t('host.view_events') : i18n.t('host.new_event')}</span>
          </button>
        </div>

        {/* Create New Event Form */}
        {isCreating ? (
          <form onSubmit={handleCreateSubmit} className="space-y-4 overflow-y-auto pr-1">
            <div>
              <label htmlFor={`${fieldIds}-1`} className="block text-xs font-semibold text-cream-300 mb-1">
                {i18n.t('host.couple_names')} *
              </label>
              <input
                id={`${fieldIds}-1`}
                type="text"
                required
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                placeholder={i18n.t('events.hosts_example')}
                className="w-full px-3.5 py-2.5 rounded-xl bg-noir-800 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
              />
            </div>

            <div>
              <label htmlFor={`${fieldIds}-2`} className="block text-xs font-semibold text-cream-300 mb-1">
                {i18n.t('ui.host_events_list.1')}
              </label>
              <input
                id={`${fieldIds}-2`}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={i18n.t('events.title_example')}
                className="w-full px-3.5 py-2.5 rounded-xl bg-noir-800 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${fieldIds}-3`} className="block text-xs font-semibold text-cream-300 mb-1">
                  {i18n.t('ui.host_events_list.2')}
                </label>
                <input
                  id={`${fieldIds}-3`}
                  type="datetime-local"
                  required
                  value={eventDate}
                  onChange={(e) => setEventDate(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-noir-800 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
                />
              </div>

              <div>
                <label htmlFor={`${fieldIds}-4`} className="block text-xs font-semibold text-cream-300 mb-1">
                  {i18n.t('ui.host_events_list.3')}
                </label>
                <input
                  id={`${fieldIds}-4`}
                  type="text"
                  value={venueName}
                  onChange={(e) => setVenueName(e.target.value)}
                  placeholder={i18n.t('events.venue_example')}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-noir-800 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
                />
              </div>
            </div>

            {errorMsg && (
              <p className="text-xs text-rosewood-300 bg-rosewood-900/40 border border-rosewood-400/30 rounded-xl p-2.5">
                {errorMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110 active:scale-98 transition-all mt-4 flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <Plus className="w-4 h-4 text-noir-900" />
              <span>{isSubmitting ? i18n.t('auth.creating') : i18n.t('events.create_new')}</span>
            </button>
          </form>
        ) : (
          /* Events List */
          <div className="space-y-3 overflow-y-auto pr-1">
            {isLoading && (
              <p className="text-xs text-cream-400/70 py-4 text-center">{i18n.t('ui.host_events_list.4')}</p>
            )}
            {errorMsg && (
              <p className="text-xs text-rosewood-300 bg-rosewood-900/40 border border-rosewood-400/30 rounded-xl p-2.5">
                {errorMsg}
              </p>
            )}
            {!isLoading && events.length === 0 && (
              <p className="text-xs text-cream-400/70 py-4 text-center">{i18n.t('ui.host_events_list.5')}</p>
            )}
            {events.map((ev) => {
              const isSelected = ev.id === currentEvent.id;

              return (
                <div
                  key={ev.id}
                  onClick={() => {
                    onSelectEvent(ev);
                    onClose();
                  }}
                  className={`p-4 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-4 ${
                    isSelected
                      ? 'bg-gold-400/15 border-gold-400 shadow-glow'
                      : 'bg-noir-800/80 border-cream-400/10 hover:border-cream-400/30'
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    {ev.coverImageUrl ? (
                      <img
                        src={ev.coverImageUrl}
                        alt={ev.title}
                        className="w-14 h-14 rounded-xl object-cover border border-cream-400/15 shrink-0"
                      />
                    ) : (
                      <div
                        aria-hidden="true"
                        className="w-14 h-14 rounded-xl border border-cream-400/15 shrink-0 bg-gradient-to-br from-gold-400/25 to-noir-900"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="font-serif font-bold text-sm text-cream-100 truncate">
                          {ev.hostName}
                        </h4>
                        {isSelected && (
                          <span className="px-2 py-0.5 rounded-full bg-gold-400 text-noir-900 text-[10px] font-bold">
                            {i18n.t('ui.host_events_list.6')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-cream-300/80 truncate mt-0.5">
                        {ev.title}
                      </p>
                      <div className="flex items-center gap-3 text-[11px] text-cream-400/70 mt-1">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-gold-400" />
                          <span>{formatEuDate(ev.eventDate)}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-gold-400" />
                          <span className="truncate max-w-[140px]">{ev.venueName}</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  <ArrowRight className={`w-5 h-5 shrink-0 ${isSelected ? 'text-gold-400' : 'text-cream-400'}`} />
                </div>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
};
