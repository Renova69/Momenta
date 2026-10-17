import fs from 'fs';
import path from 'path';
import { query } from '../../server/lib/db';

const ALBUM_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Remove album folders this test run left on local disk with no album behind
 * them (N-162).
 *
 * Every spec deletes its fixtures media first (`helpers/cleanup.ts`), and a
 * full run still left about two folders behind: an upload whose response
 * came back after its spec had already cleaned up, which only happens with
 * the suite running in parallel and never with the spec alone. Rather than
 * chase each such timing, the teardown sweeps what is provably garbage:
 *
 * - only under the given roots' `events/` folders, and only folders named as
 *   an album id;
 * - only folders created since `since` (this run's start, by this machine's
 *   clock, which is the clock the folders are stamped with);
 * - only when no album with that id exists. A concurrent run's live album has
 *   its row, so it is never touched.
 */
export async function sweepOrphanAlbumDirs(roots: string[], since: number): Promise<number> {
  const candidates: { id: string; dir: string }[] = [];
  for (const root of roots) {
    const eventsDir = path.join(root, 'events');
    if (!fs.existsSync(eventsDir)) continue;
    for (const name of fs.readdirSync(eventsDir)) {
      if (!ALBUM_DIR_NAME.test(name)) continue;
      const dir = path.join(eventsDir, name);
      const stat = fs.statSync(dir);
      // Where a filesystem keeps no creation time, the last change stands in:
      // an old orphan does not change, so it is still left alone.
      const created = stat.birthtimeMs || stat.ctimeMs;
      if (stat.isDirectory() && created >= since) candidates.push({ id: name, dir });
    }
  }
  if (candidates.length === 0) return 0;

  const { rows } = await query<{ id: string }>('SELECT id::text AS id FROM events WHERE id = ANY($1::uuid[])', [
    [...new Set(candidates.map((c) => c.id))],
  ]);
  const living = new Set(rows.map((r) => r.id));

  let removed = 0;
  for (const { id, dir } of candidates) {
    if (living.has(id)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
