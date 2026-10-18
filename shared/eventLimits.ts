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
 */
export const MAX_WEDDING_DAYS_AHEAD = 2 * 365;

/** True when `value` is a date no more than MAX_WEDDING_DAYS_AHEAD from `now`. */
export function isAcceptableWeddingDate(value: string, now: number = Date.now()): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && time <= now + MAX_WEDDING_DAYS_AHEAD * 24 * 60 * 60 * 1000;
}
