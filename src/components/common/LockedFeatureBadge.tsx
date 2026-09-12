import React from 'react';
import { i18n } from '../../i18n';
import { Lock, Sparkles } from 'lucide-react';
import { GatedFeature, FEATURE_GATES } from '../../config/tierGating';
import { PLANS } from '../../config/plans';

interface LockedFeatureBadgeProps {
  feature: GatedFeature;
  compact?: boolean;
  onUpgrade?: () => void;
}

export const LockedFeatureBadge: React.FC<LockedFeatureBadgeProps> = ({
  feature,
  compact = false,
  onUpgrade,
}) => {
  const gate = FEATURE_GATES[feature];
  const plan = PLANS[gate.minimumTier];

  if (compact) {
    return (
      <span
        onClick={(e) => {
          if (onUpgrade) {
            e.stopPropagation();
            onUpgrade();
          }
        }}
        title={`${i18n.t('gate.requires_plan')}: ${i18n.t(plan.name)}`}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-gold-400/15 border border-gold-400/40 text-gold-300 text-[9px] font-bold uppercase tracking-wider cursor-pointer hover:bg-gold-400/25 transition-colors"
      >
        <Lock className="w-2.5 h-2.5 text-gold-400" />
        <span>{i18n.t(plan.badge)}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        if (onUpgrade) {
          e.stopPropagation();
          onUpgrade();
        }
      }}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gold-400/10 border border-gold-400/30 text-gold-300 text-xs font-semibold hover:bg-gold-400/20 transition-all cursor-pointer shadow-sm group"
    >
      <Lock className="w-3 h-3 text-gold-400 group-hover:rotate-12 transition-transform" />
      <span>{i18n.t('gate.requires')} {i18n.t(plan.badge)}</span>
    </button>
  );
};

interface LockedFeatureCardProps {
  feature: GatedFeature;
  /** Optional: the card still explains the locked feature without an upgrade handler. */
  onOpenPricing?: () => void;
}

export const LockedFeatureCard: React.FC<LockedFeatureCardProps> = ({
  feature,
  onOpenPricing,
}) => {
  const gate = FEATURE_GATES[feature];
  const plan = PLANS[gate.minimumTier];

  return (
    <div className="py-12 px-6 max-w-xl mx-auto text-center rounded-3xl bg-noir-800/90 border border-gold-400/30 shadow-2xl space-y-5 animate-fade-in">
      <div className="w-16 h-16 rounded-full bg-gold-400/20 border border-gold-400/40 flex items-center justify-center mx-auto text-gold-400 shadow-glow">
        <Lock className="w-8 h-8" />
      </div>

      <div className="space-y-2">
        <span className="inline-block px-3 py-1 rounded-full bg-gold-400/10 text-gold-300 text-xs font-bold border border-gold-400/30 uppercase tracking-wider">
          {i18n.t('gate.plan_label')}: {i18n.t(plan.name)}
        </span>
        <h3 className="font-serif text-2xl sm:text-3xl font-bold text-cream-100">
          {i18n.t(gate.titleKey)}
        </h3>
        <p className="text-xs sm:text-sm text-cream-300/80 max-w-md mx-auto">
          {i18n.t(gate.descriptionKey)}
        </p>
      </div>

      <div className="pt-2">
        <button
          type="button"
          onClick={onOpenPricing}
          className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-sm shadow-glow hover:brightness-110 active:scale-98 transition-all inline-flex items-center justify-center gap-2"
        >
          <Sparkles className="w-4 h-4" />
          <span>{i18n.t('gate.upgrade_for', { price: plan.price })}</span>
        </button>
      </div>
    </div>
  );
};
