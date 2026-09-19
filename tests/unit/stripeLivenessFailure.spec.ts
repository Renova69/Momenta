import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * What "is this subscription still live at Stripe?" answers when Stripe cannot
 * be asked.
 *
 * `isSubscriptionLiveAtStripe` catches everything and returns false. That
 * direction is deliberate and load-bearing: its one caller is the downgrade
 * route, which refuses a downgrade *only* for a genuinely live subscription and
 * points the customer at the billing portal instead. Returning true on an error
 * would mean a Stripe outage, a revoked key or a network blip refuses every
 * downgrade — nobody can leave a paid plan, and the message tells them to go
 * cancel it somewhere that is also unreachable. The comment on that route says
 * a stale id "must not strand the customer"; this is the half that makes it so.
 *
 * Mutation testing found the `return false` flippable with nothing noticing:
 * the ten spec files reaching this module all exercise the pure status rule
 * (`isLiveSubscriptionStatus`) and never the failure path around it.
 *
 * The Stripe constructor is mocked rather than the module under test, because
 * STRIPE_SECRET_KEY is set in this environment — a test that let the real
 * client through would make a live network call to Stripe on every run.
 */

const retrieve = vi.hoisted(() => vi.fn());

vi.mock('stripe', () => ({
  default: class {
    subscriptions = { retrieve };
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('when Stripe cannot be reached', () => {
  it('reports the subscription as not live rather than assuming it is', async () => {
    const { isSubscriptionLiveAtStripe } = await import('../../server/lib/stripe');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    retrieve.mockRejectedValue(new Error('ECONNRESET'));

    await expect(isSubscriptionLiveAtStripe('sub_unreachable')).resolves.toBe(false);
  });

  it('does the same for an id Stripe has never heard of', async () => {
    // The stale-id case the downgrade route's comment names: the local row
    // outlived the subscription. Blocking here would strand that customer on a
    // plan they are no longer being charged for.
    const { isSubscriptionLiveAtStripe } = await import('../../server/lib/stripe');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    retrieve.mockRejectedValue(
      Object.assign(new Error('No such subscription: sub_gone'), { code: 'resource_missing' })
    );

    await expect(isSubscriptionLiveAtStripe('sub_gone')).resolves.toBe(false);
  });

  it('says so in the log, without swallowing the reason', async () => {
    // It fails open, so the log is the only trace that the question went
    // unanswered rather than being answered "no".
    const { isSubscriptionLiveAtStripe } = await import('../../server/lib/stripe');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    retrieve.mockRejectedValue(new Error('ECONNRESET'));

    await isSubscriptionLiveAtStripe('sub_unreachable');

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0])).toContain('sub_unreachable');
  });
});

describe('when Stripe does answer', () => {
  it('reports a live subscription as live', async () => {
    // Otherwise the three assertions above are satisfied by a function that
    // always returns false.
    const { isSubscriptionLiveAtStripe } = await import('../../server/lib/stripe');
    retrieve.mockResolvedValue({ status: 'active' });

    await expect(isSubscriptionLiveAtStripe('sub_active')).resolves.toBe(true);
  });

  it('reports a cancelled subscription as not live', async () => {
    const { isSubscriptionLiveAtStripe } = await import('../../server/lib/stripe');
    retrieve.mockResolvedValue({ status: 'canceled' });

    await expect(isSubscriptionLiveAtStripe('sub_cancelled')).resolves.toBe(false);
  });

  it('still counts a subscription in dunning as live', async () => {
    // past_due is live on purpose: Stripe is still retrying the card, and the
    // customer must be neither double-billed nor quietly dropped to free.
    const { isSubscriptionLiveAtStripe } = await import('../../server/lib/stripe');
    retrieve.mockResolvedValue({ status: 'past_due' });

    await expect(isSubscriptionLiveAtStripe('sub_dunning')).resolves.toBe(true);
  });
});
