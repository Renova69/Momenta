import React, { useState } from 'react';
import { PlanTier } from '../../types';
import { PLANS } from '../../config/plans';
import { i18n } from '../../i18n';
import {
  billingApi,
  isStripeNotConfiguredError,
  isManageInPortalError,
  createBillingPortalSession,
} from '../../api/billingApi';
import { hostReturnUrl } from '../../router';
import confetti from 'canvas-confetti';
import {
  X,
  Check,
  Crown,
} from 'lucide-react';

interface PricingPlansModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPlanTier: PlanTier;
  onUpgradePlan: (newTier: PlanTier) => Promise<void>;
  /** Event to return to after checkout. Omitted, the host lands on /host. */
  eventSlug?: string;
}

export const PricingPlansModal: React.FC<PricingPlansModalProps> = ({
  isOpen,
  onClose,
  currentPlanTier,
  onUpgradePlan,
  eventSlug,
}) => {
  const [, setSelectedTier] = useState<PlanTier>(currentPlanTier || 'celebration_pass');
  const [pendingTier, setPendingTier] = useState<PlanTier | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  if (!isOpen) return null;

  const runSelfServeUpgrade = async (tier: PlanTier) => {
    await onUpgradePlan(tier);
    setPendingTier(null);
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.5 },
      colors: ['#D4AF37', '#D98991', '#84A784', '#FFFFFF'],
    });
    setTimeout(() => {
      onClose();
    }, 800);
  };

  const handleSelectPlan = async (tier: PlanTier) => {
    setSelectedTier(tier);
    setUpgradeError(null);
    setPendingTier(tier);

    // Downgrading to free needs no payment step — but it does need the
    // subscription to actually be gone at Stripe. H7: the server refuses while
    // one is still live, because clearing the tier locally left the card being
    // charged for a plan the account no longer had. Send the host to the
    // Billing Portal, which is where cancelling actually stops the money.
    if (tier === 'free') {
      try {
        await runSelfServeUpgrade(tier);
      } catch (err) {
        setPendingTier(null);
        if (isManageInPortalError(err)) {
          setUpgradeError(i18n.t('billing.manage_in_portal'));
          try {
            const { url } = await createBillingPortalSession(hostReturnUrl(eventSlug));
            window.location.href = url;
          } catch {
            // The portal could not be opened (Stripe unreachable, or no
            // customer record yet). The message above already tells the host
            // what has to happen, so leave it standing rather than replacing
            // it with a second, less useful error.
          }
          return;
        }
        setUpgradeError(err instanceof Error ? err.message : i18n.t('pricing.upgrade_failed'));
      }
      return;
    }

    try {
      // Always return the host to their own dashboard, never to whichever
      // page the modal was opened from — see hostReturnUrl.
      const { url } = await billingApi.createCheckoutSession(
        tier,
        hostReturnUrl(eventSlug, { checkout: 'success' }),
        hostReturnUrl(eventSlug, { checkout: 'cancelled' })
      );
      // Full-page redirect to Stripe's own hosted checkout — the tier is
      // only ever written once Stripe's webhook confirms the payment, not
      // by this client.
      window.location.href = url;
      return;
    } catch (err) {
      if (!isStripeNotConfiguredError(err)) {
        setPendingTier(null);
        setUpgradeError(err instanceof Error ? err.message : i18n.t('pricing.upgrade_failed'));
        return;
      }
      // Stripe keys aren't set yet (server/lib/stripe.ts) — fall back to the
      // direct self-serve write so local dev/demos keep working unchanged.
    }

    try {
      await runSelfServeUpgrade(tier);
    } catch (err) {
      setPendingTier(null);
      setUpgradeError(err instanceof Error ? err.message : i18n.t('pricing.upgrade_failed'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-5xl bg-noir-900 rounded-3xl border border-gold-400/30 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="p-6 sm:p-8 text-center border-b border-cream-400/10 relative bg-gradient-to-b from-noir-800 to-noir-900">
          <button
            onClick={onClose}
            className="absolute top-5 right-5 p-2 rounded-full bg-noir-800 text-cream-300 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-gold-400/15 border border-gold-400/30 text-gold-300 text-xs font-semibold uppercase tracking-widest mb-3">
            <Crown className="w-3.5 h-3.5 text-gold-400" />
            <span>{i18n.t('ui.pricing_plans_modal.1')}</span>
          </div>

          <h2 className="font-serif text-3xl sm:text-4xl font-bold text-cream-100 mb-2">
            {i18n.t('pricing.title')}
          </h2>
          <p className="text-xs sm:text-sm text-cream-300/80 max-w-xl mx-auto">
            {i18n.t('pricing.subtitle')}
          </p>
          {upgradeError && (
            <p className="mt-3 text-xs font-semibold text-red-400" role="alert">
              {upgradeError}
            </p>
          )}
        </div>

        {/* Plan Cards Grid */}
        <div className="flex-1 overflow-y-auto p-6 sm:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {(Object.keys(PLANS) as PlanTier[]).map((tierKey) => {
              const plan = PLANS[tierKey];
              const isCurrent = currentPlanTier === tierKey;
              const isHighlighted = plan.highlighted;

              const priceDisplay = plan.price;

              return (
                <div
                  key={tierKey}
                  className={`rounded-2xl p-5 sm:p-6 border flex flex-col justify-between transition-all relative ${
                    isHighlighted
                      ? 'bg-gradient-to-b from-noir-800 to-[#1e190e] border-gold-400/50 shadow-glow'
                      : 'bg-noir-800/80 border-cream-400/10 hover:border-cream-400/30'
                  } ${isCurrent ? 'ring-2 ring-gold-400' : ''}`}
                >
                  {plan.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-gold-400 text-noir-900 text-[10px] font-bold uppercase tracking-wider shadow-md whitespace-nowrap">
                      {i18n.t(plan.badge)}
                    </div>
                  )}

                  <div>
                    <div className="mb-4">
                      <h3 className="font-serif text-lg font-bold text-cream-100">
                        {i18n.t(plan.name)}
                      </h3>
                      <p className="text-[11px] text-cream-400/80 mt-1 min-h-[32px]">
                        {i18n.t(plan.description)}
                      </p>
                    </div>

                    <div className="mb-6 pb-4 border-b border-cream-400/10">
                      <div className="flex items-baseline gap-1">
                        <span className="font-serif text-3xl font-bold text-cream-100">
                          {priceDisplay}
                        </span>
                        <span className="text-[11px] text-cream-400 font-medium">
                          / {i18n.t(plan.period)}
                        </span>
                      </div>
                      <div className="text-[10px] text-gold-400/90 font-semibold mt-1">
                        {i18n.t(plan.maxPhotos)} &middot;{' '}
                        {i18n.t('plan.cloud_storage', { size: plan.storage })}
                      </div>
                    </div>

                    {/* Features List */}
                    <ul className="space-y-2.5 mb-6 text-xs text-cream-200">
                      {plan.features.map((featKey, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px] leading-tight">
                          <Check className="w-3.5 h-3.5 text-gold-400 flex-shrink-0 mt-0.5" />
                          <span>{i18n.t(featKey)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <button
                    onClick={() => handleSelectPlan(tierKey)}
                    disabled={isCurrent || pendingTier !== null}
                    className={`w-full py-2.5 rounded-xl font-bold text-xs transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                      isCurrent
                        ? 'bg-noir-900 border border-gold-400/50 text-gold-300'
                        : isHighlighted
                        ? 'bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 shadow-glow hover:brightness-110'
                        : 'bg-noir-700 hover:bg-noir-600 text-cream-100'
                    }`}
                  >
                    {pendingTier === tierKey
                      ? i18n.t('pricing.upgrading')
                      : isCurrent
                      ? i18n.t('pricing.current_plan')
                      : i18n.t('pricing.choose_plan')}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
};
