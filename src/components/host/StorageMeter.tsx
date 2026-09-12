import React, { useEffect, useState } from 'react';
import { HardDrive, CalendarClock, AlertTriangle } from 'lucide-react';
import { eventsApi, EventUsage } from '../../api/eventsApi';
import { i18n } from '../../i18n';
import { formatEuDate } from '../../utils/date';

interface StorageMeterProps {
  eventId: string;
  onOpenPricing?: () => void;
}

/** Days left before an album's archive window closes. */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

/**
 * Shows how much of the plan's storage the album is using and when its archive
 * window closes.
 *
 * Both numbers are enforced server-side, so a host who cannot see them only
 * finds out when an upload is refused.
 */
export const StorageMeter: React.FC<StorageMeterProps> = ({ eventId, onOpenPricing }) => {
  const [usage, setUsage] = useState<EventUsage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    eventsApi
      .getUsage(eventId)
      .then((data) => {
        if (!cancelled) setUsage(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (failed || !usage) return null;

  const nearlyFull = usage.percentUsed >= 80;
  const full = usage.percentUsed >= 100;
  const daysLeft = daysUntil(usage.expiresAt);
  const expiringSoon = daysLeft !== null && daysLeft <= 14;

  const barColor = full ? 'bg-rosewood-500' : nearlyFull ? 'bg-amber-400' : 'bg-gold-400';

  return (
    <div className="p-4 rounded-2xl bg-noir-800/90 border border-cream-400/10 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-cream-400 text-xs">
          <HardDrive className="w-4 h-4 text-gold-400" />
          <span>{i18n.t('storage.title')}</span>
          {usage.pooled && (
            <span className="px-1.5 py-0.5 rounded-full bg-noir-700 text-[10px] text-cream-300">
              {i18n.t('storage.pooled')}
            </span>
          )}
        </div>
        <div className="font-mono text-xs text-cream-200 tabular-nums">
          {usage.usedLabel} / {usage.limitLabel}
        </div>
      </div>

      <div
        className="h-2 rounded-full bg-noir-900 overflow-hidden"
        role="progressbar"
        aria-valuenow={usage.percentUsed}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={i18n.t('storage.title')}
      >
        <div
          className={`h-full ${barColor} transition-all duration-500`}
          style={{ width: `${Math.max(usage.percentUsed, usage.usedBytes > 0 ? 2 : 0)}%` }}
        />
      </div>

      {nearlyFull && (
        <button
          onClick={onOpenPricing}
          className="w-full flex items-center gap-2 text-left text-xs text-amber-200 hover:text-amber-100 transition-colors"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{full ? i18n.t('storage.full') : i18n.t('storage.nearly_full')}</span>
        </button>
      )}

      {usage.expiresAt && (
        <div
          className={`flex items-center gap-2 text-xs ${
            expiringSoon ? 'text-amber-200' : 'text-cream-400/70'
          }`}
        >
          <CalendarClock className="w-3.5 h-3.5 shrink-0" />
          <span>
            {i18n.t('storage.archive_until')} {formatEuDate(usage.expiresAt)}
            {daysLeft !== null && daysLeft >= 0 && ` · ${daysLeft} ${i18n.t('storage.days_left')}`}
          </span>
        </div>
      )}
    </div>
  );
};
