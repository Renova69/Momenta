import React, { useState, useRef } from 'react';
import { storageService, ReactionKind } from '../../services/storageService';
import { i18n } from '../../i18n';

// Client-side half of P6 — the server also rate-limits per IP, but that lets
// a single guest tapping rapidly still flood the room's WebSocket channel
// before the server ever sees it as abuse. Cap sends at the source.
const MAX_REACTIONS_PER_SECOND = 5;
const RATE_WINDOW_MS = 1000;

interface ReactionBarProps {
  guestName?: string;
}

// Emoji are built from code points so the source stays plain ASCII.
const REACTIONS: { kind: ReactionKind; glyph: string; labelKey: string }[] = [
  { kind: 'heart', glyph: String.fromCodePoint(0x2764, 0xfe0f), labelKey: 'reaction.heart' },
  { kind: 'clap', glyph: String.fromCodePoint(0x1f44f), labelKey: 'reaction.clap' },
  { kind: 'cheers', glyph: String.fromCodePoint(0x1f942), labelKey: 'reaction.cheers' },
  { kind: 'laugh', glyph: String.fromCodePoint(0x1f602), labelKey: 'reaction.laugh' },
  { kind: 'party', glyph: String.fromCodePoint(0x1f389), labelKey: 'reaction.party' },
];

/**
 * Sends an ephemeral reaction that animates on the venue's projector wall.
 *
 * Nothing is stored — this is the "everyone in the room sees it at once" moment,
 * not a like. The local bounce is immediate so the tap feels answered even
 * before the round trip completes.
 */
export const ReactionBar: React.FC<ReactionBarProps> = ({ guestName }) => {
  const [justSent, setJustSent] = useState<ReactionKind | null>(null);
  const sendTimestamps = useRef<number[]>([]);

  const send = (kind: ReactionKind) => {
    const now = Date.now();
    sendTimestamps.current = sendTimestamps.current.filter((t) => now - t < RATE_WINDOW_MS);
    if (sendTimestamps.current.length >= MAX_REACTIONS_PER_SECOND) return;
    sendTimestamps.current.push(now);

    storageService.sendReaction(kind, guestName);
    setJustSent(kind);
    window.setTimeout(() => setJustSent((current) => (current === kind ? null : current)), 600);
  };

  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3">
      <span className="text-[0.68rem] uppercase tracking-widest text-cream-400/60 font-bold hidden sm:inline">
        {i18n.t('reaction.prompt')}
      </span>
      {REACTIONS.map(({ kind, glyph, labelKey }) => (
        <button
          key={kind}
          type="button"
          onClick={() => send(kind)}
          aria-label={i18n.t(labelKey)}
          title={i18n.t(labelKey)}
          className={`w-11 h-11 rounded-full border text-xl leading-none flex items-center justify-center transition-all active:scale-90 ${
            justSent === kind
              ? 'border-gold-400 bg-gold-400/20 scale-110'
              : 'border-cream-400/15 bg-noir-800/80 hover:border-gold-400/50 hover:bg-noir-800'
          }`}
        >
          <span aria-hidden="true">{glyph}</span>
        </button>
      ))}
    </div>
  );
};
