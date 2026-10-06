import { describe, it, expect } from 'vitest';
import { query } from '../../server/lib/db';

/**
 * The test run's database sessions skip waiting for each commit to reach the
 * disk (vitest.config.ts, PGOPTIONS). Without it, every commit costs about
 * 200 ms on a Docker Desktop volume, and specs near the timeout fail whenever
 * the machine is busy. Pinned so a config edit cannot drop it silently.
 */
describe('the test database session', () => {
  it('does not wait for each commit to be flushed to disk', async () => {
    const { rows } = await query<{ synchronous_commit: string }>('SHOW synchronous_commit');

    expect(rows[0].synchronous_commit).toBe('off');
  });
});
