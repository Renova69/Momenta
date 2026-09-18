import { query } from '../../server/lib/db';
import { purgeEventMedia } from '../../server/lib/retention';

/**
 * Delete event fixtures the way production deletes an event: media first.
 *
 * `DELETE FROM events` cascades to the photo and audio rows, and those rows are
 * the only record of where the bytes live. Delete them first and the files are
 * stranded with nothing left to identify them — this repository's most-repeated
 * bug, recorded four separate times against application code.
 *
 * Its own test suite did it in forty spec files. A full run left roughly 7,000
 * orphaned album directories and 421 MB behind, which is where the 10,431
 * directories swept off this machine came from. The suite was reproducing, on
 * every run, the exact failure it exists to catch.
 *
 * So the ordering is not a tidiness detail here. Every spec that uses this
 * helper exercises the same sequence production must follow, and a spec that
 * skips it now fails `tests/unit/fixtureCleanup.spec.ts` rather than quietly
 * leaking.
 *
 * Failures are swallowed on purpose: cleanup runs in `afterAll`, often after a
 * test has already failed and left the fixture half-built. Throwing here would
 * replace a real failure with a misleading one.
 */
export async function deleteEventFixtures(eventIds: ReadonlyArray<string | undefined | null>): Promise<void> {
  const ids = eventIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return;

  for (const id of ids) {
    // Media before rows, always.
    await purgeEventMedia(id).catch(() => undefined);
  }

  await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [ids]).catch(() => undefined);
}

/** Single-event convenience, for the many specs that create exactly one. */
export async function deleteEventFixture(eventId: string | undefined | null): Promise<void> {
  return deleteEventFixtures([eventId]);
}

/**
 * The same, for specs that only know the host.
 *
 * Resolves the ids first so the media purge has something to work from — the
 * reason this cannot simply be `DELETE FROM events WHERE host_user_id = $1`.
 */
export async function deleteEventFixturesForHost(userId: string | undefined | null): Promise<void> {
  if (!userId) return;

  const { rows } = await query<{ id: string }>('SELECT id::text AS id FROM events WHERE host_user_id = $1', [
    userId,
  ]).catch(() => ({ rows: [] as { id: string }[] }));

  await deleteEventFixtures(rows.map((r) => r.id));
}
