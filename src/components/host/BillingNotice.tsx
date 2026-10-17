import React, { useEffect, useState } from 'react';
import { AlertCircle, CreditCard } from 'lucide-react';
import { billingApi, createBillingPortalSession } from '../../api/billingApi';
import { hostReturnUrl } from '../../router';
import { i18n } from '../../i18n';
import { formatDateDDMMYYYY } from './dashboard/dateFields';

interface BillingNoticeProps {
  /** The album to come back to from the billing portal. */
  eventSlug: string;
}

/**
 * Tells the host their subscription payment failed, while there is still time
 * to fix it (N-152), and that the plan is suspended once the time is up.
 *
 * Stripe retries a failed renewal, and the webhook keeps the plan until a
 * grace deadline; then the plan ends. Until this, nothing said so: no email
 * can go out while SMTP is unset, and the studio looked like any paid-up
 * plan. Shows nothing when all is well, or when the status cannot be read.
 */
export const BillingNotice: React.FC<BillingNoticeProps> = ({ eventSlug }) => {
  const [notice, setNotice] = useState<{ planEndsAt: string } | { suspended: true } | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;
    billingApi
      .getStatus()
      .then((status) => {
        if (!isCurrent) return;
        if (status.paymentFailed && status.planEndsAt) setNotice({ planEndsAt: status.planEndsAt });
        else if (status.planSuspended) setNotice({ suspended: true });
      })
      .catch(() => {
        // Not knowing is not news: the studio carries on without the notice.
      });
    return () => {
      isCurrent = false;
    };
  }, []);

  if (!notice) return null;

  const openPortal = async () => {
    setIsOpening(true);
    setPortalError(null);
    try {
      const { url } = await createBillingPortalSession(hostReturnUrl(eventSlug));
      window.location.href = url;
    } catch {
      setPortalError(i18n.t('billing.portal_failed'));
      setIsOpening(false);
    }
  };

  return (
    <div
      role="status"
      className="p-4 rounded-2xl border bg-rosewood-950/80 border-rosewood-500/30 text-rosewood-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle className="w-5 h-5 shrink-0 text-rosewood-400" aria-hidden="true" />
        <div className="text-xs space-y-1">
          <p className="font-bold">
            {'planEndsAt' in notice
              ? i18n.t('billing.payment_failed', { date: formatDateDDMMYYYY(notice.planEndsAt) })
              : i18n.t('billing.plan_suspended')}
          </p>
          {portalError && <p className="text-red-300">{portalError}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={openPortal}
        disabled={isOpening}
        className="shrink-0 px-4 py-2 rounded-xl bg-gold-400 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110 disabled:opacity-60 flex items-center gap-1.5"
      >
        <CreditCard className="w-3.5 h-3.5" aria-hidden="true" />
        <span>{i18n.t('billing.update_card')}</span>
      </button>
    </div>
  );
};
