import React from 'react';
import { Lock } from 'lucide-react';
import { i18n } from '../../i18n';
import { formatDateDDMMYYYY } from '../host/dashboard/dateFields';

interface AlbumClosedNoticeProps {
  /** When the album closed: its `expiresAt`. */
  closedAt: string;
  /**
   * The album's host only. With it the notice is the host's, and offers a
   * plan that opens the album again; without it, it is the guests'.
   */
  onOpenPricing?: () => void;
}

/**
 * Says an album has closed to new photos, and what can still be done (N-159).
 * Looking and downloading stay; uploads, voice messages, comments and
 * reactions stop until a plan moves the album's deadline forward.
 */
export const AlbumClosedNotice: React.FC<AlbumClosedNoticeProps> = ({ closedAt, onOpenPricing }) => {
  const date = formatDateDDMMYYYY(closedAt);
  return (
    <div
      role="status"
      className="p-4 rounded-2xl border bg-noir-800/90 border-gold-400/30 text-cream-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
    >
      <div className="flex items-start gap-2.5">
        <Lock className="w-5 h-5 shrink-0 text-gold-400" aria-hidden="true" />
        <p className="text-xs font-semibold">
          {i18n.t(onOpenPricing ? 'album.closed_host' : 'album.closed_guest', { date })}
        </p>
      </div>
      {onOpenPricing && (
        <button
          type="button"
          onClick={onOpenPricing}
          className="shrink-0 px-4 py-2 rounded-xl bg-gold-400 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110"
        >
          {i18n.t('album.reopen')}
        </button>
      )}
    </div>
  );
};
