import React from 'react';
import { Sparkles, Heart } from 'lucide-react';
import { i18n } from '../../i18n';

interface LoadingSpinnerProps {
  message?: string;
  fullscreen?: boolean;
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  message,
  fullscreen = false,
}) => {
  const displayMessage = message || i18n.t('common.loading');

  const content = (
    <div className="flex flex-col items-center justify-center gap-4 p-8 text-center animate-fade-in">
      <div className="relative flex items-center justify-center">
        <div className="w-16 h-16 rounded-full border-4 border-gold-500/20 border-t-gold-500 animate-spin" />
        <Heart className="w-6 h-6 text-gold-400 fill-gold-400 absolute animate-pulse" />
      </div>
      <div className="space-y-1">
        <h3 className="font-serif text-lg text-cream-100 font-medium flex items-center justify-center gap-2">
          <Sparkles className="w-4 h-4 text-gold-400 animate-bounce" />
          <span>WedMoments</span>
        </h3>
        <p className="text-xs text-cream-400/80">{displayMessage}</p>
      </div>
    </div>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 bg-noir-900/90 backdrop-blur-md z-50 flex items-center justify-center">
        {content}
      </div>
    );
  }

  return content;
};
