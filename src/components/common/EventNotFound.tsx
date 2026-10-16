import React from 'react';
import { CalendarX, Plus, Home, RefreshCw } from 'lucide-react';
import { i18n } from '../../i18n';

interface EventNotFoundProps {
  slug?: string;
  /**
   * `missing` — there is no album at this address.
   * `unreachable` — the server could not be asked. A guest at a venue with
   * weak wifi has a perfectly good QR code, and telling them their wedding
   * does not exist is both wrong and alarming.
   */
  reason?: 'missing' | 'unreachable' | 'deleted';
  onGoHome: () => void;
  onCreateEvent: () => void;
  onRetry?: () => void;
}

export const EventNotFound: React.FC<EventNotFoundProps> = ({
  slug,
  reason = 'missing',
  onGoHome,
  onCreateEvent,
  onRetry,
}) => {
  const unreachable = reason === 'unreachable';
  const deleted = reason === 'deleted';
  return (
    <div className="min-h-screen bg-noir-900 text-cream-100 flex items-center justify-center p-6 animate-fade-in">
      <div className="max-w-md w-full bg-noir-800/90 border border-gold-500/20 rounded-3xl p-8 text-center space-y-6 shadow-2xl backdrop-blur-xl">
        <div className="w-20 h-20 rounded-full bg-gold-500/10 border border-gold-500/30 text-gold-400 mx-auto flex items-center justify-center">
          <CalendarX className="w-10 h-10" />
        </div>

        <div className="space-y-2">
          <h2 className="font-serif text-2xl font-semibold text-cream-100">
            {i18n.t(
              deleted ? 'event.deleted_title' : unreachable ? 'event.unreachable_title' : 'common.not_found_title'
            )}
          </h2>
          <p className="text-xs text-cream-400/80">
            {deleted ? (
              i18n.t('event.deleted_hint')
            ) : unreachable ? (
              i18n.t('event.unreachable_hint')
            ) : slug ? (
              <>
                {i18n.t('event.not_found_at')}{' '}
                <code className="text-gold-400 font-mono bg-noir-900 px-1.5 py-0.5 rounded-sm">/e/{slug}</code>
              </>
            ) : (
              i18n.t('event.link_expired')
            )}
          </p>
        </div>

        <div className="space-y-3 pt-2">
          {unreachable && onRetry && (
            <button
              onClick={onRetry}
              className="w-full py-3 px-6 rounded-2xl bg-linear-to-r from-gold-500 to-gold-400 text-noir-900 font-bold text-sm flex items-center justify-center gap-2 shadow-glow hover:opacity-95 transition-opacity"
            >
              <RefreshCw className="w-4 h-4" />
              <span>{i18n.t('event.try_again')}</span>
            </button>
          )}
          <button
            onClick={onGoHome}
            className={`w-full py-3 px-6 rounded-2xl font-bold text-sm flex items-center justify-center gap-2 transition-opacity ${
              unreachable && onRetry
                ? 'bg-noir-700 hover:bg-noir-600 text-cream-200 border border-cream-400/10'
                : 'bg-linear-to-r from-gold-500 to-gold-400 text-noir-900 shadow-glow hover:opacity-95'
            }`}
          >
            <Home className="w-4 h-4" />
            <span>{i18n.t('common.go_home')}</span>
          </button>

          <button
            onClick={onCreateEvent}
            className="w-full py-3 px-6 rounded-2xl bg-noir-700 hover:bg-noir-600 text-cream-200 font-semibold text-xs flex items-center justify-center gap-2 border border-cream-400/10 transition-colors"
          >
            <Plus className="w-4 h-4 text-gold-400" />
            <span>{i18n.t('common.create_new')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
