import React, { useEffect, useId, useRef, useState } from 'react';
import { PlanTier } from '../../types';
import { PLANS } from '../../config/plans';
import { i18n } from '../../i18n';
import { LegalNotice } from '../legal/LegalLinks';
import { useDialog } from '../../hooks/useDialog';
import {
  billingApi,
  isStripeNotConfiguredError,
  isManageInPortalError,
  createBillingPortalSession,
} from '../../api/billingApi';
import { hostReturnUrl } from '../../router';
import { TIER_WEIGHTS } from '../../config/tierGating';
import confetti from 'canvas-confetti';
import {
  X,
  Check,
  Crown,
} from 'lucide-react';

/** The one plan billed monthly (server/lib/stripePlans.ts). */
const SUBSCRIPTION_TIER: PlanTier = 'pro_planner';

interface PricingPlansModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPlanTier: PlanTier;
  onUpgradePlan: (newTier: PlanTier) => Promise<void>;
  /** Event to return to after checkout. Omitted, the host lands on /host. */
  eventSlug?: string;
  /**
   * Set when nobody is signed in: choosing a plan calls this instead of
   * starting a checkout that has no account to charge (N-151).
   */
  onSignInRequired?: () => void;
}

export const PricingPlansModal: React.FC<PricingPlansModalProps> = ({
  isOpen,
  onClose,
  currentPlanTier,
  onUpgradePlan,
  eventSlug,
  onSignInRequired,
}) => {
  const [, setSelectedTier] = useState<PlanTier>(currentPlanTier || 'celebration_pass');
  const [pendingTier, setPendingTier] = useState<PlanTier | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  // N-51 — giving up a paid plan is asked about first, never done on one click.
  const [confirmingFree, setConfirmingFree] = useState(false);
  // N-164 — the one-time pass an ending subscription falls back to, if any.
  const [keptTier, setKeptTier] = useState<PlanTier | null>(null);
  const titleId = useId();
  const confirmTitleId = useId();
  const confirmBodyId = useId();
  const keepPlanRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, dialogProps } = useDialog({ onClose, labelledBy: titleId, enabled: isOpen });

  // Kept mounted while closed, a question left open must not greet the host
  // the next time they open it. (App mounts it only while open, see
  // HostDialogs, but the component does not rely on that.)
  useEffect(() => {
    if (!isOpen) {
      setConfirmingFree(false);
      setUpgradeError(null);
    }
  }, [isOpen]);

  // Focus the safe answer, so a keyboard user does not have to tab back past
  // the plan grid to reach the question.
  useEffect(() => {
    if (confirmingFree) keepPlanRef.current?.focus();
  }, [confirmingFree]);

  // Asked when the question opens, and only of a subscriber: a pass can sit
  // underneath a subscription, never underneath another pass. Without an
  // answer the question says what it always said.
  useEffect(() => {
    if (!confirmingFree || currentPlanTier !== SUBSCRIPTION_TIER) return;
    let isCurrent = true;
    billingApi
      .getStatus()
      .then((status) => {
        if (isCurrent && status.keepsTier && status.keepsTier in PLANS) setKeptTier(status.keepsTier);
      })
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, [confirmingFree, currentPlanTier]);

  if (!isOpen) return null;

  const runSelfServeUpgrade = async (tier: PlanTier) => {
    await onUpgradePlan(tier);
    setPendingTier(null);
    // Losing a plan is not a celebration (N-51).
    if (tier === 'free') {
      onClose();
      return;
    }
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

  const handleSelectPlan = async (tier: PlanTier, confirmed = false) => {
    setUpgradeError(null);

    if (onSignInRequired) {
      onSignInRequired();
      return;
    }

    // N-51 — a one-time pass was paid for once, is not refunded, and does not
    // come back. Name what is about to be lost and wait for a yes.
    if (tier === 'free' && currentPlanTier !== 'free' && !confirmed) {
      setConfirmingFree(true);
      return;
    }
    setConfirmingFree(false);

    setSelectedTier(tier);
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
        // The plan bought rides on the return URL, so the page that receives
        // the host knows what to wait for (N-54).
        hostReturnUrl(eventSlug, { checkout: 'success', tier }),
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
    <div
      ref={dialogRef}
      {...dialogProps}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in"
    >
      <div className="relative w-full max-w-5xl bg-noir-900 rounded-3xl border border-gold-400/30 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="p-6 sm:p-8 text-center border-b border-cream-400/10 relative bg-linear-to-b from-noir-800 to-noir-900">
          <button
            onClick={onClose}
            aria-label={i18n.t('common.close')}
            className="absolute top-5 right-5 p-2 rounded-full bg-noir-800 text-cream-300 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-gold-400/15 border border-gold-400/30 text-gold-300 text-xs font-semibold uppercase tracking-widest mb-3">
            <Crown className="w-3.5 h-3.5 text-gold-400" />
            <span>{i18n.t('ui.pricing_plans_modal.1')}</span>
          </div>

          <h2 id={titleId} className="font-serif text-3xl sm:text-4xl font-bold text-cream-100 mb-2">
            {i18n.t('pricing.title')}
          </h2>
          <p className="text-xs sm:text-sm text-cream-300/80 max-w-xl mx-auto">
            {i18n.t('pricing.subtitle')}
          </p>
          {/* N-163 — the terms of sale are owed before payment. */}
          <div className="mt-2">
            <LegalNotice kind="pricing" />
          </div>
          {upgradeError && (
            <p className="mt-3 text-xs font-semibold text-red-400" role="alert">
              {upgradeError}
            </p>
          )}
          {confirmingFree && (
            <div
              role="alert"
              aria-labelledby={confirmTitleId}
              aria-describedby={confirmBodyId}
              className="mt-5 mx-auto max-w-xl rounded-2xl border border-red-400/40 bg-red-500/10 p-4 text-left"
            >
              <p id={confirmTitleId} className="text-sm font-semibold text-cream-100">
                {keptTier
                  ? i18n.t('pricing.confirm_free_title_keeps', {
                      plan: i18n.t(PLANS[currentPlanTier].name),
                      kept: i18n.t(PLANS[keptTier].name),
                    })
                  : i18n.t('pricing.confirm_free_title', { plan: i18n.t(PLANS[currentPlanTier].name) })}
              </p>
              <p id={confirmBodyId} className="mt-1 text-xs text-cream-300">
                {keptTier
                  ? i18n.t('pricing.confirm_free_body_keeps', { kept: i18n.t(PLANS[keptTier].name) })
                  : i18n.t('pricing.confirm_free_body')}
              </p>
              <div className="mt-4 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
                <button
                  ref={keepPlanRef}
                  onClick={() => setConfirmingFree(false)}
                  disabled={pendingTier !== null}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-gold-400 text-noir-900 hover:brightness-110"
                >
                  {i18n.t('pricing.confirm_free_keep', { plan: i18n.t(PLANS[currentPlanTier].name) })}
                </button>
                <button
                  onClick={() => handleSelectPlan('free', true)}
                  disabled={pendingTier !== null}
                  className="px-4 py-2 rounded-xl text-xs font-bold border border-red-400/50 text-red-300 hover:bg-red-500/15"
                >
                  {i18n.t('pricing.confirm_free_switch')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Plan Cards Grid */}
        <div className="flex-1 overflow-y-auto p-6 sm:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {(Object.keys(PLANS) as PlanTier[]).map((tierKey) => {
              const plan = PLANS[tierKey];
              // A visitor has no plan: the one passed in is the album's.
              const isCurrent = !onSignInRequired && currentPlanTier === tierKey;
              // N-155 — a paid plan the current one already includes is not
              // for sale; the server refuses it as ALREADY_ENTITLED.
              const isIncluded =
                !onSignInRequired &&
                !isCurrent &&
                tierKey !== 'free' &&
                (TIER_WEIGHTS[tierKey] ?? 0) < (TIER_WEIGHTS[currentPlanTier] ?? 0);
              const isHighlighted = plan.highlighted;

              const priceDisplay = plan.price;

              return (
                <div
                  key={tierKey}
                  className={`rounded-2xl p-5 sm:p-6 border flex flex-col justify-between transition-all relative ${
                    isHighlighted
                      ? 'bg-linear-to-b from-noir-800 to-[#1e190e] border-gold-400/50 shadow-glow'
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
                          <Check className="w-3.5 h-3.5 text-gold-400 shrink-0 mt-0.5" />
                          <span>{i18n.t(featKey)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <button
                    onClick={() => handleSelectPlan(tierKey)}
                    disabled={isCurrent || isIncluded || pendingTier !== null}
                    className={`w-full py-2.5 rounded-xl font-bold text-xs transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                      isCurrent || isIncluded
                        ? 'bg-noir-900 border border-gold-400/50 text-gold-300'
                        : isHighlighted
                        ? 'bg-linear-to-r from-gold-400 to-gold-500 text-noir-900 shadow-glow hover:brightness-110'
                        : 'bg-noir-700 hover:bg-noir-600 text-cream-100'
                    }`}
                  >
                    {pendingTier === tierKey
                      ? i18n.t('pricing.upgrading')
                      : isCurrent
                      ? i18n.t('pricing.current_plan')
                      : isIncluded
                      ? i18n.t('pricing.included')
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
