/**
 * Plan caps that both halves of the app must agree on.
 *
 * The free tier's photo ceiling was previously written out three times — in
 * `server/lib/planLimits.ts`, in `server/middleware/tierGate.ts` and in
 * `src/config/tierGating.ts`. The server enforces it and the client renders a
 * warning as a guest approaches it, so a change to one copy and not the others
 * shows guests a limit the upload endpoint does not apply.
 *
 * `shared/` is in both `tsconfig.json` (client) and `tsconfig.server.json`
 * (server), which makes it the one place a number like this can live where
 * neither side can drift from it.
 */

/** Photos a free-tier album accepts before uploads are refused. */
export const FREE_TIER_MAX_PHOTOS = 50;

/**
 * Per-guest upload ceiling applied when a host has not set one on the event.
 *
 * Distinct from FREE_TIER_MAX_PHOTOS, which caps the album as a whole: this
 * caps any single guest's contribution to it, on every tier.
 */
export const DEFAULT_MAX_PHOTOS_PER_GUEST = 50;

/**
 * The plan tiers, in order, as a comparable weight.
 *
 * Written out twice before this — `server/middleware/tierGate.ts` and
 * `src/config/tierGating.ts` — which is the same drift risk as the photo cap
 * above, with a worse failure: the client decides what to show behind a
 * paywall and the server decides what to allow, so a disagreement either sells
 * a feature that is then refused, or hides one the customer has paid for.
 */
export type PlanTierName = 'free' | 'celebration_pass' | 'deluxe_keepsake' | 'pro_planner';

export const TIER_WEIGHTS: Record<PlanTierName, number> = {
  free: 0,
  celebration_pass: 1,
  deluxe_keepsake: 2,
  pro_planner: 3,
};
