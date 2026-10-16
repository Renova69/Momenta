import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * What "is this subscription still live at Stripe?" answers when Stripe cannot
 * be asked.
 *
 * It used to catch everything and answer "not live", on the reasoning that the
 * downgrade route refuses only a genuinely live subscription, and refusing on
 * every error would leave nobody able to leave a paid plan during an outage.
 * But "not live" lets the downgrade through: a timeout, a 429 or a 5xx at the
 * moment a host clicked "downgrade to free" dropped the tier while the
 * subscription went on billing, and the next renewal refreshed nothing — the
 * H7 outcome, by a transient error (N-42).
 *
 * So there are three answers. An id Stripe has never heard of is `ended`: the
 * stale row the downgrade route says must not strand the customer. A failure
 * to ask is `unknown`, and the callers refuse *for now* with a retry message
 * rather than either guessing or pointing at a portal that is also
 * unreachable.
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

// The key is pinned here, not read from .env. Without one the client is never
// built and every answer below is 'unknown' for that reason alone: CI has no
// key, so four of these passed only on a machine whose .env held one. The
// constructor above is mocked, so the value is never sent anywhere.
vi.mock('../../server/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/config')>();
  return { ...actual, CONFIG: { ...actual.CONFIG, STRIPE_SECRET_KEY: 'sk_test_liveness_spec' } };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('when Stripe cannot be reached', () => {
  it('answers unknown, not "not live"', async () => {
    const { subscriptionLivenessAtStripe } = await import('../../server/lib/stripe');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    retrieve.mockRejectedValue(new Error('ECONNRESET'));

    await expect(subscriptionLivenessAtStripe('sub_unreachable')).resolves.toBe('unknown');
  });

  it('answers unknown for a rate limit or a Stripe outage too', async () => {
    const { subscriptionLivenessAtStripe } = await import('../../server/lib/stripe');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    retrieve.mockRejectedValueOnce(Object.assign(new Error('Too many requests'), { statusCode: 429 }));
    retrieve.mockRejectedValueOnce(Object.assign(new Error('Internal error'), { statusCode: 500 }));

    await expect(subscriptionLivenessAtStripe('sub_busy')).resolves.toBe('unknown');
    await expect(subscriptionLivenessAtStripe('sub_busy')).resolves.toBe('unknown');
  });

  it('answers ended for an id Stripe has never heard of', async () => {
    // The stale-id case the downgrade route's comment names: the local row
    // outlived the subscription. Blocking here would strand that customer on a
    // plan they are no longer being charged for.
    const { subscriptionLivenessAtStripe } = await import('../../server/lib/stripe');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    retrieve.mockRejectedValue(
      Object.assign(new Error('No such subscription: sub_gone'), { code: 'resource_missing', statusCode: 404 })
    );

    await expect(subscriptionLivenessAtStripe('sub_gone')).resolves.toBe('ended');
  });

  it('says so in the log, without swallowing the reason', async () => {
    const { subscriptionLivenessAtStripe } = await import('../../server/lib/stripe');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    retrieve.mockRejectedValue(new Error('ECONNRESET'));

    await subscriptionLivenessAtStripe('sub_unreachable');

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0])).toContain('sub_unreachable');
  });
});

describe('when Stripe does answer', () => {
  it('reports a live subscription as live', async () => {
    const { subscriptionLivenessAtStripe } = await import('../../server/lib/stripe');
    retrieve.mockResolvedValue({ status: 'active' });

    await expect(subscriptionLivenessAtStripe('sub_active')).resolves.toBe('live');
  });

  it('reports a cancelled subscription as ended', async () => {
    const { subscriptionLivenessAtStripe } = await import('../../server/lib/stripe');
    retrieve.mockResolvedValue({ status: 'canceled' });

    await expect(subscriptionLivenessAtStripe('sub_cancelled')).resolves.toBe('ended');
  });

  it('still counts a subscription in dunning as live', async () => {
    // past_due is live on purpose: Stripe is still retrying the card, and the
    // customer must be neither double-billed nor quietly dropped to free.
    const { subscriptionLivenessAtStripe } = await import('../../server/lib/stripe');
    retrieve.mockResolvedValue({ status: 'past_due' });

    await expect(subscriptionLivenessAtStripe('sub_dunning')).resolves.toBe('live');
  });
});
