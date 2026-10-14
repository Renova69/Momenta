import React, { useEffect, useId, useState } from 'react';
import { i18n } from '../../../i18n';
import { formatDateDDMMYYYY, formatTime24h, maskDateInput, maskTimeInput, parseDateAndTime } from './dateFields';

interface RevealTimeFieldProps {
  /** When the album's disposable photos are revealed, or null before the server has set it. */
  revealAt: string | null | undefined;
  /** Save a new reveal, as an ISO instant. */
  onCommit: (revealAt: string) => void;
}

/**
 * When a disposable album reveals (N-109).
 *
 * The toggle promises "the morning after the wedding", and for a long time
 * nothing set any time at all, so every locked photo was published at once.
 * The server now sets that morning when the mode is switched on; this shows
 * it, in the same day-and-time fields as the wedding itself, and lets the host
 * move it. Saved when the host leaves a field, like the wedding date.
 */
export const RevealTimeField: React.FC<RevealTimeFieldProps> = ({ revealAt, onCommit }) => {
  const labelId = useId();
  const [dateText, setDateText] = useState(() => (revealAt ? formatDateDDMMYYYY(revealAt) : ''));
  const [timeText, setTimeText] = useState(() => (revealAt ? formatTime24h(revealAt) : ''));

  useEffect(() => {
    setDateText(revealAt ? formatDateDDMMYYYY(revealAt) : '');
    setTimeText(revealAt ? formatTime24h(revealAt) : '');
  }, [revealAt]);

  if (!revealAt) {
    return <p className="text-[11px] text-cream-400/70 px-1">{i18n.t('host.reveal_pending')}</p>;
  }

  const commit = () => {
    const parsed = parseDateAndTime(dateText, timeText);
    if (!parsed) return;
    const next = parsed.toISOString();
    if (new Date(next).getTime() !== new Date(revealAt).getTime()) onCommit(next);
  };

  const fieldClass =
    'px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400 font-mono';

  return (
    <div role="group" aria-labelledby={labelId} className="px-1 space-y-1">
      <span id={labelId} className="block text-xs font-semibold text-cream-300">
        {i18n.t('host.reveal_label')}
      </span>
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          aria-label={i18n.t('host.reveal_date_field')}
          placeholder="ДД.ММ.ГГГГ"
          maxLength={10}
          value={dateText}
          onChange={(e) => setDateText(maskDateInput(e.target.value))}
          onBlur={commit}
          className={`w-full ${fieldClass}`}
        />
        <input
          type="text"
          inputMode="numeric"
          aria-label={i18n.t('host.reveal_time_field')}
          placeholder="ЧЧ:ММ"
          maxLength={5}
          value={timeText}
          onChange={(e) => setTimeText(maskTimeInput(e.target.value))}
          onBlur={commit}
          className={`w-24 ${fieldClass}`}
        />
      </div>
      <p className="text-[11px] text-cream-400/70">{i18n.t('host.reveal_hint')}</p>
    </div>
  );
};
