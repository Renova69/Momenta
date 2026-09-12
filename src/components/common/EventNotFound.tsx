import React from 'react';
import { CalendarX, Plus, Home } from 'lucide-react';
import { i18n } from '../../i18n';

interface EventNotFoundProps {
  slug?: string;
  onGoHome: () => void;
  onCreateEvent: () => void;
}

export const EventNotFound: React.FC<EventNotFoundProps> = ({
  slug,
  onGoHome,
  onCreateEvent,
}) => {
  return (
    <div className="min-h-screen bg-noir-900 text-cream-100 flex items-center justify-center p-6 animate-fade-in">
      <div className="max-w-md w-full bg-noir-800/90 border border-gold-500/20 rounded-3xl p-8 text-center space-y-6 shadow-2xl backdrop-blur-xl">
        <div className="w-20 h-20 rounded-full bg-gold-500/10 border border-gold-500/30 text-gold-400 mx-auto flex items-center justify-center">
          <CalendarX className="w-10 h-10" />
        </div>

        <div className="space-y-2">
          <h2 className="font-serif text-2xl font-semibold text-cream-100">{i18n.t('common.not_found_title')}</h2>
          <p className="text-xs text-cream-400/80">
            {slug ? (
              <>
                {i18n.t('event.not_found_at')}{' '}
                <code className="text-gold-400 font-mono bg-noir-900 px-1.5 py-0.5 rounded">/e/{slug}</code>
              </>
            ) : (
              i18n.t('event.link_expired')
            )}
          </p>
        </div>

        <div className="space-y-3 pt-2">
          <button
            onClick={onGoHome}
            className="w-full py-3 px-6 rounded-2xl bg-gradient-to-r from-gold-500 to-gold-400 text-noir-900 font-bold text-sm flex items-center justify-center gap-2 shadow-glow hover:opacity-95 transition-opacity"
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
