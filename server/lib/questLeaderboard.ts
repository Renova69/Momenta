import { pool } from './db';

/**
 * The scavenger-hunt leaderboard.
 *
 * The host hands a real prize to whoever tops this, so it counts only what a
 * guest has shown, not what they have claimed. A completion scores while the
 * guest still has at least one photo for that quest which:
 *
 *   - exists — a host who deletes every photo for a quest takes its points
 *     with them;
 *   - belongs to that guest, and
 *   - was uploaded for that quest. Completions are only written by the upload
 *     now, which satisfies both by construction, but rows written by the
 *     claim endpoint that used to exist could name any photo id — somebody
 *     else's, or one photo for every quest — and may still be in a database;
 *   - is not rejected by moderation. A pending photo does score: the host has
 *     not decided yet, and a guest should not drop off the board while they
 *     wait.
 *
 * "At least one", rather than the photo the completion row happens to point
 * at, because a retake repoints it (upload.ts, ON CONFLICT DO UPDATE). A
 * guest whose second attempt was rejected would otherwise lose a quest their
 * first, approved photo still satisfies — scoring zero while their own card
 * still read "Completed".
 *
 * Completions recorded with no photo at all — left behind by that endpoint, or
 * by a photo since deleted — never score.
 *
 * Every join is pinned to the event, so a guest or photo from another wedding
 * cannot appear here however the completion row came to exist.
 *
 * Ties go to whoever reached their score first, which is the rule a host
 * would apply by hand, and the guest id breaks what little is left so the
 * order is stable between refreshes.
 */

export interface LeaderboardEntry {
  rank: number;
  guestId: string;
  name: string;
  avatarUrl: string | null;
  points: number;
  questsCompleted: number;
  /**
   * The quests that scored. A guest's own phone uses these to mark each quest
   * card: its photo list is paginated, so it cannot tell by itself whether an
   * older quest photo still counts.
   */
  questIds: string[];
}

/** A wedding has a few hundred guests at most; this only bounds a pathological event. */
export const LEADERBOARD_MAX_ENTRIES = 500;

export async function getQuestLeaderboard(eventId: string): Promise<LeaderboardEntry[]> {
  const { rows } = await pool.query<LeaderboardEntry>(
    `SELECT ROW_NUMBER() OVER (
              ORDER BY SUM(sq.points) DESC, MAX(gqc.completed_at) ASC, g.id ASC
            )::int                         AS rank,
            g.id                           AS "guestId",
            g.name,
            g.avatar_url                   AS "avatarUrl",
            SUM(sq.points)::int            AS points,
            COUNT(*)::int                  AS "questsCompleted",
            array_agg(sq.id::text ORDER BY sq.id) AS "questIds"
       FROM guest_quest_completions gqc
       JOIN scavenger_quests sq ON sq.id = gqc.quest_id
       JOIN guests g            ON g.id = gqc.guest_id AND g.event_id = sq.event_id
      WHERE sq.event_id = $1
        AND EXISTS (
              SELECT 1
                FROM photos p
               WHERE p.event_id = sq.event_id
                 AND p.guest_id = g.id
                 AND p.quest_id = sq.id
                 AND p.status <> 'rejected'
            )
      GROUP BY g.id
      ORDER BY rank
      LIMIT $2`,
    [eventId, LEADERBOARD_MAX_ENTRIES]
  );
  return rows;
}
