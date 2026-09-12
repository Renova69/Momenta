import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  parseIntervalHours,
  buildSweeps,
  maintenanceLogDir,
  logFileFor,
  parseReportRetentionDays,
  pruneOldReports,
  parseOnce,
  runAllOnce,
} from '../../scripts/maintenance-scheduler';
import type { Sweep } from '../../scripts/maintenance-scheduler';

/**
 * The maintenance scheduler had no tests at all, and one real hazard.
 *
 * Both sweep intervals came from `parseInt(process.env.X || 'n', 10) * HOUR_MS`
 * with nothing checking the result. `RETENTION_INTERVAL_HOURS=0`, a negative,
 * or a typo like `24h` all yield `0` or `NaN`, and `setInterval` treats both as
 * "as fast as possible" — so one character turns a daily report into a sweep
 * process respawned the instant the previous one exits, against the production
 * database, forever.
 *
 * What makes that genuinely dangerous rather than merely wrong is that it does
 * not look like a failure. The `running` guard keeps it to one process at a
 * time, so nothing crashes and nothing queues up; the startup banner prints
 * "every 0h" or "every NaNh" and the service simply never stops working.
 */
describe('maintenance scheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseIntervalHours', () => {
    it('accepts a plain number of hours', () => {
      expect(parseIntervalHours('24', 1, 'X')).toBe(24 * 60 * 60 * 1000);
      expect(parseIntervalHours('1', 24, 'X')).toBe(60 * 60 * 1000);
    });

    it('keeps a fractional interval instead of truncating it', () => {
      // parseInt('0.5') is 0 — which is exactly the runaway case. Number() is
      // used precisely so a half-hour interval means half an hour.
      expect(parseIntervalHours('0.5', 24, 'X')).toBe(30 * 60 * 1000);
    });

    it('falls back when the value is absent or blank', () => {
      expect(parseIntervalHours(undefined, 24, 'X')).toBe(24 * 60 * 60 * 1000);
      expect(parseIntervalHours('', 24, 'X')).toBe(24 * 60 * 60 * 1000);
      expect(parseIntervalHours('   ', 24, 'X')).toBe(24 * 60 * 60 * 1000);
    });

    it('refuses every value that would schedule a continuous loop', () => {
      const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      for (const bad of ['0', '-5', 'abc', '24h', 'NaN', 'Infinity']) {
        expect({ bad, ms: parseIntervalHours(bad, 24, 'RETENTION_INTERVAL_HOURS') }).toEqual({
          bad,
          ms: 24 * 60 * 60 * 1000,
        });
      }

      expect(warn).toHaveBeenCalledTimes(6);
      expect(warn.mock.calls[0][0]).toContain('RETENTION_INTERVAL_HOURS');
    });

    it('never returns a value setInterval would treat as zero', () => {
      for (const raw of ['0', '-1', 'abc', undefined, '', '24']) {
        const ms = parseIntervalHours(raw, 24, 'X');
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeGreaterThan(0);
      }
    });
  });

  describe('buildSweeps', () => {
    it('schedules every sweep with its documented default', () => {
      const sweeps = buildSweeps({});

      // retention-notice comes first deliberately: an album must be warned
      // before it can ever become deletable, and while the sweep enforces that
      // regardless of ordering, there is no reason to make a host wait an
      // extra day for a notice that was already due.
      expect(sweeps.map((s) => s.name)).toEqual(['retention-notice', 'subscription-grace', 'retention']);
      expect(sweeps.find((s) => s.name === 'retention-notice')?.intervalMs).toBe(24 * 60 * 60 * 1000);
      expect(sweeps.find((s) => s.name === 'retention')?.intervalMs).toBe(24 * 60 * 60 * 1000);
      expect(sweeps.find((s) => s.name === 'subscription-grace')?.intervalMs).toBe(60 * 60 * 1000);
    });

    it('keeps notice sending opt-in, so no album becomes deletable by default', () => {
      const notice = buildSweeps({}).find((s) => s.name === 'retention-notice');

      expect(notice?.script).toBe('scripts/retention-notify.ts');
      expect(notice?.enforceVar).toBe('NOTICE_SEND');
    });

    it('keeps the retention report on the schedule, report-only by default', () => {
      // OPEN_ITEMS.md D1 depends on this running unattended for weeks without
      // ever deleting anything on its own.
      const retention = buildSweeps({}).find((s) => s.name === 'retention');

      expect(retention?.script).toBe('scripts/retention-sweep.ts');
      expect(retention?.enforceVar).toBe('RETENTION_ENFORCED');
    });

    it('honours a configured interval', () => {
      const sweeps = buildSweeps({ RETENTION_INTERVAL_HOURS: '6', GRACE_INTERVAL_HOURS: '2' });

      expect(sweeps.find((s) => s.name === 'retention')?.intervalMs).toBe(6 * 60 * 60 * 1000);
      expect(sweeps.find((s) => s.name === 'subscription-grace')?.intervalMs).toBe(2 * 60 * 60 * 1000);
    });

    it('falls back per-sweep, so one bad value does not affect the other', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const sweeps = buildSweeps({ RETENTION_INTERVAL_HOURS: '0', GRACE_INTERVAL_HOURS: '3' });

      expect(sweeps.find((s) => s.name === 'retention')?.intervalMs).toBe(24 * 60 * 60 * 1000);
      expect(sweeps.find((s) => s.name === 'subscription-grace')?.intervalMs).toBe(3 * 60 * 60 * 1000);
    });
  });

  describe('report retention', () => {
    it('keeps one file per sweep per day', () => {
      const when = new Date('2026-09-11T13:45:00.000Z');

      const retention = logFileFor('retention', when, { MAINTENANCE_LOG_DIR: '/var/log/wm' });
      const grace = logFileFor('subscription-grace', when, { MAINTENANCE_LOG_DIR: '/var/log/wm' });

      expect(path.basename(retention)).toBe('retention-2026-09-11.log');
      expect(path.basename(grace)).toBe('subscription-grace-2026-09-11.log');
      expect(retention).not.toBe(grace);
    });

    it('groups runs from the same day into the same file', () => {
      const morning = new Date('2026-09-11T06:00:00.000Z');
      const evening = new Date('2026-09-11T22:00:00.000Z');
      const env = { MAINTENANCE_LOG_DIR: '/var/log/wm' };

      expect(logFileFor('retention', morning, env)).toBe(logFileFor('retention', evening, env));
    });

    it('separates days, so a fortnight of reports sits side by side', () => {
      const env = { MAINTENANCE_LOG_DIR: '/var/log/wm' };

      expect(logFileFor('retention', new Date('2026-09-11T12:00:00Z'), env)).not.toBe(
        logFileFor('retention', new Date('2026-09-12T12:00:00Z'), env)
      );
    });

    it('defaults to a directory inside the project when unconfigured', () => {
      expect(maintenanceLogDir({})).toBe(path.join(process.cwd(), 'logs', 'maintenance'));
    });
  });

  /**
   * Pruning the reports.
   *
   * One file per sweep per day, forever, on a volume nobody looks at is the
   * same shape of problem retention itself exists to solve — small, but
   * unbounded. The window is generous (90 days by default, against the few
   * weeks D1 asks for) because the cost of keeping them is trivial and the
   * cost of having deleted a report someone needed is not.
   *
   * These tests are mostly about what pruning must NOT do. It deletes files in
   * an operator-configured directory which, under compose, is a mount point —
   * so the interesting assertions are the ones pinning that it leaves
   * everything it did not write strictly alone.
   */
  describe('report retention window', () => {
    let dir: string;

    const env = (): NodeJS.ProcessEnv => ({ MAINTENANCE_LOG_DIR: dir });
    const write = (name: string): void => fs.writeFileSync(path.join(dir, name), 'report\n');
    const remaining = (): string[] => fs.readdirSync(dir).sort();

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-reports-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('parseReportRetentionDays', () => {
      it('defaults to 90 days', () => {
        expect(parseReportRetentionDays(undefined)).toBe(90);
        expect(parseReportRetentionDays('')).toBe(90);
      });

      it('accepts an explicit window', () => {
        expect(parseReportRetentionDays('30')).toBe(30);
      });

      it('treats 0 and "never" as keep-forever', () => {
        expect(parseReportRetentionDays('0')).toBe(0);
        expect(parseReportRetentionDays('never')).toBe(0);
        expect(parseReportRetentionDays('NEVER')).toBe(0);
      });

      it('falls back rather than deleting more, on any garbage', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        // The direction matters: a typo must never be able to widen what gets
        // deleted, so every unusable value lands on the default, not on 0 and
        // not on NaN (which would compare false and delete nothing, but only
        // by accident).
        for (const bad of ['-1', 'abc', '30d', 'NaN', 'Infinity']) {
          expect({ bad, days: parseReportRetentionDays(bad) }).toEqual({ bad, days: 90 });
        }
      });
    });

    it('removes reports older than the window', () => {
      const now = new Date('2026-09-11T12:00:00.000Z');
      write('retention-2026-06-01.log');
      write('retention-notice-2026-06-01.log');

      const result = pruneOldReports(now, { ...env(), MAINTENANCE_LOG_RETENTION_DAYS: '30' });

      expect(result.removed.sort()).toEqual(['retention-2026-06-01.log', 'retention-notice-2026-06-01.log']);
      expect(remaining()).toEqual([]);
    });

    it('keeps reports inside the window', () => {
      const now = new Date('2026-09-11T12:00:00.000Z');
      write('retention-2026-09-10.log');
      write('retention-2026-08-20.log');

      const result = pruneOldReports(now, { ...env(), MAINTENANCE_LOG_RETENTION_DAYS: '30' });

      expect(result.removed).toEqual([]);
      expect(remaining()).toEqual(['retention-2026-08-20.log', 'retention-2026-09-10.log']);
    });

    it("never removes today's report", () => {
      // The one being appended to right now.
      const now = new Date('2026-09-11T12:00:00.000Z');
      write('retention-2026-09-11.log');

      pruneOldReports(now, { ...env(), MAINTENANCE_LOG_RETENTION_DAYS: '1' });

      expect(remaining()).toEqual(['retention-2026-09-11.log']);
    });

    it('leaves every file it did not write alone', () => {
      // MAINTENANCE_LOG_DIR is operator-configured and is a mount point under
      // compose, so this can run against a directory holding things nobody
      // asked us to manage. Dated or not, none of these is ours.
      const now = new Date('2030-01-01T00:00:00.000Z');
      const strangers = [
        'notes.txt',
        'README.md',
        'postgresql.conf',
        'PG_VERSION',
        'retention.log',
        'retention-2026-06-01.log.gz',
        'archive-2026-06-01.log.bak',
        '.hidden',
      ];
      for (const name of strangers) write(name);
      fs.mkdirSync(path.join(dir, 'base'));

      const result = pruneOldReports(now, { ...env(), MAINTENANCE_LOG_RETENTION_DAYS: '1' });

      expect(result.removed).toEqual([]);
      expect(remaining()).toEqual([...strangers, 'base'].sort());
    });

    it('deletes nothing when the window is disabled', () => {
      const now = new Date('2030-01-01T00:00:00.000Z');
      write('retention-2020-01-01.log');

      const result = pruneOldReports(now, { ...env(), MAINTENANCE_LOG_RETENTION_DAYS: 'never' });

      expect(result.removed).toEqual([]);
      expect(remaining()).toEqual(['retention-2020-01-01.log']);
    });

    it('treats a missing directory as the normal pre-first-run state', () => {
      const missing = path.join(dir, 'not-created-yet');

      expect(() => pruneOldReports(new Date(), { MAINTENANCE_LOG_DIR: missing })).not.toThrow();
      expect(pruneOldReports(new Date(), { MAINTENANCE_LOG_DIR: missing }).removed).toEqual([]);
    });

    it('survives a report it cannot delete', () => {
      // A log the scheduler cannot remove is untidy; taking the sweeps down
      // over it would be worse.
      const now = new Date('2030-01-01T00:00:00.000Z');
      write('retention-2020-01-01.log');
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
        throw new Error('EBUSY');
      });

      try {
        const result = pruneOldReports(now, { ...env(), MAINTENANCE_LOG_RETENTION_DAYS: '1' });

        expect(result.removed).toEqual([]);
        expect(result.kept).toBe(1);
        expect(err).toHaveBeenCalled();
      } finally {
        unlink.mockRestore();
        err.mockRestore();
      }
    });
  });

  /**
   * `--once`: run each sweep once and exit.
   *
   * For cron, for a one-shot container, and for checking by hand what the
   * sweeps say — the last of which is how five orphaned scheduler processes
   * came to be running against this database at once, because the only way to
   * see the output was to start the long-running form and then kill it.
   *
   * The exit code carries the result. A sweep that fails silently under cron is
   * the classic way for a job like this to stop working without anyone
   * noticing, and it is the entire reason the mode reports rather than just
   * runs.
   */
  describe('--once', () => {
    const fakeSweep = (name: string): Sweep => ({
      name,
      script: `scripts/${name}.ts`,
      enforceVar: 'RETENTION_ENFORCED',
      intervalMs: 60_000,
    });

    describe('parseOnce', () => {
      it('recognises the flag wherever it appears', () => {
        expect(parseOnce(['--once'])).toBe(true);
        expect(parseOnce(['--verbose', '--once'])).toBe(true);
      });

      it('defaults to the scheduled form', () => {
        expect(parseOnce([])).toBe(false);
        expect(parseOnce(['--verbose'])).toBe(false);
        // Near-misses must not silently turn a long-running service into a
        // one-shot that exits seconds after deploying.
        expect(parseOnce(['once'])).toBe(false);
        expect(parseOnce(['--onces'])).toBe(false);
        expect(parseOnce(['-once'])).toBe(false);
      });
    });

    it('runs every sweep, in the declared order', async () => {
      // Sequential and ordered: the notice sweep must precede the retention
      // sweep, because an album has to be warned before it can be deleted.
      const order: string[] = [];
      const sweeps = [fakeSweep('retention-notice'), fakeSweep('subscription-grace'), fakeSweep('retention')];

      const failures = await runAllOnce(sweeps, async (s) => {
        order.push(s.name);
        return 0;
      });

      expect(order).toEqual(['retention-notice', 'subscription-grace', 'retention']);
      expect(failures).toBe(0);
    });

    it('waits for each sweep before starting the next', async () => {
      // One sweep at a time means one connection pool at a time, which is the
      // difference between this being safe to cron on a small database and not.
      let active = 0;
      let maxActive = 0;

      await runAllOnce([fakeSweep('a'), fakeSweep('b'), fakeSweep('c')], async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return 0;
      });

      expect(maxActive).toBe(1);
    });

    it('counts the failures', async () => {
      const failures = await runAllOnce(
        [fakeSweep('a'), fakeSweep('b'), fakeSweep('c')],
        async (s) => (s.name === 'b' ? 1 : 0)
      );

      expect(failures).toBe(1);
    });

    it('keeps going after a failure rather than stopping at the first', async () => {
      // A broken notice sweep must not stop the retention report from being
      // produced — they are independent, and the report is what gets read.
      const ran: string[] = [];

      const failures = await runAllOnce([fakeSweep('a'), fakeSweep('b'), fakeSweep('c')], async (s) => {
        ran.push(s.name);
        return s.name === 'a' ? 2 : 0;
      });

      expect(ran).toEqual(['a', 'b', 'c']);
      expect(failures).toBe(1);
    });

    it('reports success only when every sweep succeeded', async () => {
      const sweeps = [fakeSweep('a'), fakeSweep('b')];

      expect(await runAllOnce(sweeps, async () => 0)).toBe(0);
      expect(await runAllOnce(sweeps, async () => 1)).toBe(2);
    });
  });
});
