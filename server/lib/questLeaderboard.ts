import { pool } from './db';

/**
 * The scavenger-hunt leaderboard.
 *
 * The host hands a real prize to whoever tops this, so it counts only what a
 * guest has shown, not what they have claimed. A completion scores when its
 * photo:
 *
 *   - still exists — a host who deletes a photo takes its points with it
 *     (the foreign key sets `photo_id` to NULL, which the join drops);
 *   - belongs to the same guest — `POST /quests/:id/complete` accepts any
 *     photo id, so without this a guest could claim a quest with somebody
 *     else's picture;
 *   - was uploaded for that quest — the same route would otherwise let one
 *     photo claim every quest;
 *   - is not rejected by moderation. A pending photo does score: the host has
 *     not decided yet, and a guest should not drop off the board while they
 *     wait.
 *
 * Completions recorded with no photo at all never score. The client claims a
 * quest as soon as the photo is taken, before the upload reaches the server,
 * and anyone can send that claim; it still shows as a tick on the guest's own
 * quest list, which is all it ever was.
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
       JOIN photos p            ON p.id = gqc.photo_id
                               AND p.event_id = sq.event_id
                               AND p.guest_id = g.id
                               AND p.quest_id = sq.id
      WHERE sq.event_id = $1
        AND p.status <> 'rejected'
      GROUP BY g.id
      ORDER BY rank
      LIMIT $2`,
    [eventId, LEADERBOARD_MAX_ENTRIES]
  );
  return rows;
}
