import React from 'react';
import { ScavengerQuest, Guest } from '../../types';
import { i18n } from '../../i18n';
import {
  CheckCircle2,
  Camera,
  Heart,
  Music,
  Smile,
  Wine,
  Sparkles,
  Award,
  Users
} from 'lucide-react';

interface ScavengerHuntProps {
  quests: ScavengerQuest[];
  currentGuest: Guest;
  onSelectQuestForCapture: (questId: string) => void;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  heart: <Heart className="w-5 h-5 text-rosewood-400" />,
  music: <Music className="w-5 h-5 text-gold-400" />,
  smile: <Smile className="w-5 h-5 text-sage-400" />,
  camera: <Camera className="w-5 h-5 text-gold-300" />,
  wine: <Wine className="w-5 h-5 text-rosewood-300" />,
  // Seeded quests use 'users' ("the funniest group selfie"), so without this
  // entry a stock quest silently falls back to the camera icon.
  users: <Users className="w-5 h-5 text-sage-300" />,
};

export const ScavengerHunt: React.FC<ScavengerHuntProps> = ({
  quests,
  currentGuest,
  onSelectQuestForCapture,
}) => {
  const completedCount = quests.filter((q) =>
    q.completedByGuestIds.includes(currentGuest.id)
  ).length;

  const totalPoints = quests.reduce((acc, q) => {
    return acc + (q.completedByGuestIds.includes(currentGuest.id) ? q.points : 0);
  }, 0);

  const progressPercent = Math.round((completedCount / (quests.length || 1)) * 100);

  return (
    <div className="space-y-6">
      {/* Gamification Status Card */}
      <div className="bg-gradient-to-r from-noir-800 via-[#1f1a10] to-noir-800 rounded-3xl p-6 border border-gold-400/30 shadow-2xl relative overflow-hidden">
        <div className="absolute right-0 top-0 translate-x-8 -translate-y-8 w-48 h-48 bg-gold-400/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-gold-400/20 border border-gold-400/50 flex items-center justify-center shadow-glow">
              <Award className="w-7 h-7 text-gold-400" />
            </div>
            <div>
              <h3 className="font-serif text-xl font-bold text-cream-100">
                {i18n.t('quests.title')}
              </h3>
              <p className="text-xs text-cream-400/80">
                {i18n.t('quests.subtitle')}
              </p>
            </div>
          </div>

          {/* Points Pill */}
          <div className="px-4 py-2 rounded-2xl bg-gold-400/15 border border-gold-400/30 text-gold-300 flex items-center gap-2 self-stretch sm:self-auto justify-center">
            <Sparkles className="w-4 h-4 text-gold-400" />
            <span className="font-serif text-lg font-bold">{totalPoints} {i18n.t('quests.pts')}</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-cream-300 font-medium">
            <span>{i18n.t('quests.progress')} ({completedCount} / {quests.length} {i18n.t('quests.done')})</span>
            <span>{progressPercent}%</span>
          </div>
          <div className="w-full h-3 bg-noir-900 rounded-full overflow-hidden border border-cream-400/10 p-0.5">
            <div
              className="h-full bg-gradient-to-r from-gold-500 to-gold-400 rounded-full transition-all duration-700 shadow-glow"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* Quests Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {quests.map((quest) => {
          const isCompleted = quest.completedByGuestIds.includes(currentGuest.id);
          const icon = ICON_MAP[quest.iconName] || <Camera className="w-5 h-5 text-gold-400" />;

          return (
            <div
              key={quest.id}
              className={`p-5 rounded-2xl border transition-all flex flex-col justify-between ${
                isCompleted
                  ? 'bg-noir-800/50 border-sage-400/30 text-cream-300'
                  : 'bg-noir-800/90 border-cream-400/15 hover:border-gold-400/50 shadow-md'
              }`}
            >
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-noir-900 border border-cream-400/10 flex items-center justify-center shrink-0">
                    {icon}
                  </div>
                  <div>
                    <h4 className={`font-serif text-base font-bold ${isCompleted ? 'line-through text-cream-400' : 'text-cream-100'}`}>
                      {quest.title}
                    </h4>
                    <p className="text-xs text-cream-300/80 mt-0.5">
                      {quest.description}
                    </p>
                  </div>
                </div>

                <span className="px-2.5 py-1 rounded-full bg-gold-400/10 border border-gold-400/30 text-gold-300 text-xs font-bold shrink-0">
                  +{quest.points} {i18n.t('quests.pts')}
                </span>
              </div>

              {/* Action */}
              <div className="pt-3 border-t border-cream-400/10 flex items-center justify-between">
                {isCompleted ? (
                  <div className="flex items-center gap-1.5 text-sage-400 text-xs font-medium">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{i18n.t('quests.done')}</span>
                  </div>
                ) : (
                  <button
                    onClick={() => onSelectQuestForCapture(quest.id)}
                    className="flex items-center gap-1.5 text-xs font-bold text-gold-400 hover:text-gold-300 hover:underline transition-all"
                  >
                    <Camera className="w-4 h-4" />
                    <span>{i18n.t('quests.snap_challenge')}</span>
                  </button>
                )}
                
                <span className="text-[11px] text-cream-400/60">
                  {quest.completedByGuestIds.length} {i18n.t('hero.guests_joined').toLowerCase()}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
