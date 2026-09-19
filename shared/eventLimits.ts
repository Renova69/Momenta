/**
 * Length limits on event text that both sides must agree on.
 *
 * The server's UpdateEventSchema refuses anything longer; the host dashboard
 * caps its input at the same length, so a save is never refused after the
 * dashboard has already said "saved". One constant, so the two cannot drift.
 */

/** The host's grand prize announcement (`events.quest_prize`, migration 027). */
export const QUEST_PRIZE_MAX_LENGTH = 500;
