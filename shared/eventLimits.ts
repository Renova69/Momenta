/**
 * Length limits on event text that both sides must agree on.
 *
 * The server's UpdateEventSchema refuses anything longer; the host dashboard
 * caps its input at the same length, so a save is never refused after the
 * dashboard has already said "saved". One constant, so the two cannot drift.
 */

/** The host's grand prize announcement (`events.quest_prize`, migration 027). */
export const QUEST_PRIZE_MAX_LENGTH = 500;

/**
 * N-168 — how far ahead a wedding date may be set. The album's deadline is
 * counted from the wedding, so an unbounded date kept an album open for as
 * long as the host liked. Two years covers any real engagement.
 *
 * N-200 — calendar years, the owner's rule (2026-10-20): the same day two
 * years on is allowed, at any hour, whatever 29 February falls between. It
 * was 730 days, which refused that day whenever a leap day was in the span.
 */
export const MAX_WEDDING_YEARS_AHEAD = 2;

/**
 * A date, then optionally a time and an offset: ISO 8601, as the studio sends
 * it (`toISOString()`).
 *
 * N-194 — anything looser was read by JavaScript's parser here and stored by
 * Postgres with its own, and the two disagree: '12/31/69' is 1969 to one and
 * 2069 to the other. Only this shape means the same instant to both.
 */
const ISO_WEDDING_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** The instant `value` names, or null when it is not an ISO date that exists. */
export function parseWeddingDate(value: string): number | null {
  const match = ISO_WEDDING_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  // 30 February is refused, not rolled into March.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * The end of the same day MAX_WEDDING_YEARS_AHEAD years after `now` (UTC).
 * From 29 February that is 1 March.
 */
export function latestWeddingDate(now: number = Date.now()): number {
  const today = new Date(now);
  return Date.UTC(today.getUTCFullYear() + MAX_WEDDING_YEARS_AHEAD, today.getUTCMonth(), today.getUTCDate() + 1);
}

/** True when `value` is an ISO date that exists and is not past latestWeddingDate. */
export function isAcceptableWeddingDate(value: string, now: number = Date.now()): boolean {
  const time = parseWeddingDate(value);
  return time !== null && time < latestWeddingDate(now);
}
