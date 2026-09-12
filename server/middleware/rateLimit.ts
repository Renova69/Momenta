import { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Rate limiting for an event where every guest shares one IP.
 *
 * A wedding is the pathological case for IP-based limits: 80 guests are all
 * behind the venue's single NAT, so a per-IP budget is really a per-wedding
 * budget. The original 30-uploads-per-minute ceiling meant the whole reception
 * shared it — and the moment everyone shoots at once, the first dance, is
 * exactly when guests would start seeing "Too many uploads".
 *
 * So guest traffic is limited per *device* for fairness, with a much higher
 * per-IP ceiling kept as an abuse backstop. A device fingerprint is
 * client-supplied and therefore rotatable, which is precisely why the IP
 * backstop stays.
 *
 * Quantity is not this layer's job: `max_photos_per_guest` and the plan's
 * storage allowance already bound how much any one wedding can store.
 */

/** Per-guest fairness, falling back to the IP when no fingerprint is supplied. */
function deviceKey(req: Request): string {
  const body = req.body as { deviceFingerprint?: unknown } | undefined;
  const fingerprint =
    (typeof body?.deviceFingerprint === 'string' && body.deviceFingerprint) ||
    (typeof req.query?.deviceFingerprint === 'string' && req.query.deviceFingerprint) ||
    (typeof req.headers['x-device-fingerprint'] === 'string' && req.headers['x-device-fingerprint']);

  // ipKeyGenerator normalises IPv6 so a single client cannot rotate through a /64.
  return fingerprint ? `fp:${fingerprint}` : `ip:${ipKeyGenerator(req.ip || '')}`;
}

/**
 * Uploads from one guest's phone. Twenty a minute is far more than anyone
 * shoots by hand, and it keeps one device from monopolising the encoder.
 */
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: deviceKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads from this device. Please wait a moment before trying again.' },
});

/**
 * Abuse backstop for the whole venue. Sized for a large reception in full flow
 * (200 guests, a burst each) rather than for one person.
 */
export const uploadIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'This network is sending uploads unusually fast. Please try again shortly.' },
});

// Rate limiter for authentication attempts (25 attempts per 15 minutes per IP).
// Hosts sign in from their own connection, so a per-IP limit is right here.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
});

// Live reactions are cheap but spammable — one every ~2 seconds per guest keeps
// the projector wall celebratory rather than a wall of noise.
export const reactionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: deviceKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reactions. Give the dance floor a moment.' },
});

/**
 * Photo comments (H8).
 *
 * Comments write unbounded text rows and, for a first-time device, a guest
 * row — and until now the only thing covering this endpoint was the 3000/min
 * global ceiling, which is a venue-wide browsing budget rather than anything
 * resembling a limit on writing. Twenty a minute is far more than anyone
 * types by hand.
 */
export const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: deviceKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many comments from this device. Please wait a moment before posting again.' },
});

/**
 * Abuse backstop for comments across the whole venue.
 *
 * The per-device key above is client-supplied and therefore rotatable, which
 * is exactly why this stays — the same reasoning as uploadIpLimiter, sized for
 * a large reception talking at once rather than for one person.
 */
export const commentIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'This network is sending comments unusually fast. Please try again shortly.' },
});

/**
 * Other guest-initiated writes that are not uploads, likes or comments —
 * quest completions, today (H8).
 *
 * Naturally bounded by the handful of quests an event has and an
 * ON CONFLICT DO NOTHING insert, so this is defence in depth rather than the
 * thing doing the real work; what actually closed the abuse was no longer
 * minting a guest row per request.
 */
export const guestActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: deviceKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this device. Please wait a moment.' },
});

/**
 * General API ceiling.
 *
 * Applied to every /api route, so it carries the whole venue's browsing: feed
 * loads, likes, comments, gallery refreshes. At 200/minute a wedding of any size
 * would trip it, which is why it is sized per venue rather than per person.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' },
});
