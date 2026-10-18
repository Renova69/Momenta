import type Stripe from 'stripe';
import { getStripeClient, isLiveSubscriptionStatus, retrieveSubscriptionOrNull } from './stripe';

/**
 * Give back a checkout's payment the app cannot use (N-172, N-173): the
 * account it was for has been deleted, or it bought a plan the account
 * already holds (two tabs, or a retry after a slow redirect). The owner's
 * rule (2026-10-18): refund automatically rather than keep money nobody can
 * spend, or leave it to be noticed.
 *
 * A subscription the checkout started is cancelled first, so it never charges
 * again. The refund carries an idempotency key per session, so a webhook that
 * Stripe retries after a failure here never refunds twice. Throws when Stripe
 * cannot be reached, which rolls the webhook back for Stripe to retry.
 */
export async function refundCheckoutSession(session: Stripe.Checkout.Session, reason: string): Promise<void> {
  const stripe = getStripeClient();

  const subscriptionId = idOf(session.subscription);
  if (subscriptionId) {
    const subscription = await retrieveSubscriptionOrNull(subscriptionId);
    if (subscription && isLiveSubscriptionStatus(subscription.status)) {
      await stripe.subscriptions.cancel(subscriptionId);
    }
  }

  const paymentIntent = idOf(session.payment_intent) ?? (await invoicePaymentIntent(idOf(session.invoice)));
  if (!paymentIntent) {
    console.error(
      `[Billing] could not find the payment of checkout session ${session.id} to refund (${reason}) — refund it by hand in the Stripe dashboard`
    );
    return;
  }

  await stripe.refunds.create(
    { payment_intent: paymentIntent, metadata: { checkout_session: session.id, reason } },
    { idempotencyKey: `refund-${session.id}` }
  );
  console.warn(`[Billing] refunded checkout session ${session.id}: ${reason}`);
}

/** A subscription's first payment lives on its invoice, not on the session. */
async function invoicePaymentIntent(invoiceId: string | null): Promise<string | null> {
  if (!invoiceId) return null;
  const payments = await getStripeClient().invoicePayments.list({ invoice: invoiceId, limit: 5 });
  for (const entry of payments.data) {
    const intent = idOf(entry.payment.payment_intent ?? null);
    if (intent) return intent;
  }
  return null;
}

/**
 * The status at Stripe of the subscription an account has on file, or null
 * when Stripe no longer has it. Throws when Stripe cannot be asked, so the
 * webhook is retried rather than guessing (N-172).
 */
export async function storedSubscriptionStatus(subscriptionId: string): Promise<Stripe.Subscription.Status | null> {
  const subscription = await retrieveSubscriptionOrNull(subscriptionId);
  return subscription ? subscription.status : null;
}

/**
 * Stop a failing subscription that a new one has replaced (N-172): left
 * live, Stripe goes on retrying the old card, and a later success would bill
 * the customer for two.
 */
export async function cancelReplacedSubscription(subscriptionId: string): Promise<void> {
  await getStripeClient().subscriptions.cancel(subscriptionId);
  console.warn(`[Billing] cancelled failing subscription ${subscriptionId}, replaced by a new checkout`);
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}
