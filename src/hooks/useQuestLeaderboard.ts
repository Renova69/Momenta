import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { questsApi } from '../api/questsApi';
import { Photo, QuestLeaderboardEntry, ScavengerQuest } from '../types';

/** Long enough to fold a burst of uploads into one request. */
const REFETCH_DEBOUNCE_MS = 1500;

/** Catches score changes this client is never told about. */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Everything on this client that moves when a score can: claims on each
 * quest, and each quest photo with its moderation status. A photo arriving,
 * being rejected or being deleted each changes this string.
 */
export function leaderboardTrigger(quests: ScavengerQuest[], photos: Photo[]): string {
  const claims = quests.map((q) => `${q.id}:${q.completedByGuestIds.length}`).join(',');
  const questPhotos = photos
    .filter((p) => p.questId)
    .map((p) => `${p.id}:${p.status}`)
    .join(',');
  return `${claims}|${questPhotos}`;
}

/**
 * The quest leaderboard, kept close to live without a socket message of its
 * own.
 *
 * Scores change when a quest photo arrives, is rejected or is deleted, and
 * each of those already reaches this client as a change to `quests` or
 * `photos`. So the hook refetches, debounced, when `leaderboardTrigger` moves.
 * A slow poll covers what never reaches this client at all: in a moderated
 * event a guest is not sent other guests' pending photos, yet those score.
 *
 * Returns null until the first answer arrives, so a caller can tell "not
 * loaded yet" from "nobody has scored": a guest's points must not flash 0
 * while the request is in flight. A failed fetch keeps the last board on
 * screen; the next change or tick tries again.
 */
export function useQuestLeaderboard(
  eventId: string | undefined,
  enabled: boolean,
  quests: ScavengerQuest[],
  photos: Photo[]
): QuestLeaderboardEntry[] | null {
  const [entries, setEntries] = useState<QuestLeaderboardEntry[] | null>(null);
  // Only the newest request may write: a slow response must not overwrite a
  // fresher one, and nothing may land after the event changes or unmounts.
  const latestRequest = useRef(0);

  const load = useCallback(() => {
    if (!enabled || !eventId) return;
    const request = ++latestRequest.current;
    questsApi.leaderboard(eventId).then(
      (next) => {
        if (request === latestRequest.current) setEntries(next);
      },
      () => undefined
    );
  }, [eventId, enabled]);

  useEffect(() => {
    setEntries(null);
  }, [eventId]);

  // At once, then on a slow timer.
  useEffect(() => {
    if (!enabled || !eventId) return;
    // A request counter, not a DOM node: bumping it in cleanup is the point.
    const requests = latestRequest;
    load();
    const poll = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(poll);
      requests.current++;
    };
  }, [load, enabled, eventId]);

  // Soon after anything that can move a score. The first value is skipped:
  // the effect above has just fetched for it.
  const trigger = useMemo(() => leaderboardTrigger(quests, photos), [quests, photos]);
  const lastTrigger = useRef(trigger);
  useEffect(() => {
    if (trigger === lastTrigger.current) return;
    lastTrigger.current = trigger;
    const debounce = window.setTimeout(load, REFETCH_DEBOUNCE_MS);
    return () => window.clearTimeout(debounce);
  }, [trigger, load]);

  return entries;
}
