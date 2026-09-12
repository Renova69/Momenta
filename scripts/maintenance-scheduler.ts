/**
 * Long-running scheduler for the three maintenance sweeps.
 *
 *   npm run maintenance        — schedule them, and keep running
 *   npm run maintenance:once   — run each one once, then exit
 *
 * `--once` exists for cron, for a one-shot container, and for checking by hand
 * what the sweeps currently say. It exits non-zero if any sweep did.
 *
 * All three were written to be run "from cron" — and nothing ran them. In a
 * container deployment that is easy to miss and expensive to leave: without the
 * retention sweep, storage grows forever against a one-time fee, which is the
 * exact gap retention was built to close; without the grace sweep, a Pro
 * Planner subscription whose dunning ends without another Stripe webhook keeps
 * its tier indefinitely; without the notice sweep no host is ever warned, and
 * an unwarned album can never be deleted however retention is configured.
 *
 * This runs as its own compose service (see docker-compose.yml), sharing the
 * app image and database. It shells out to the same CLI entry points rather
 * than importing their internals, so there is exactly one implementation of
 * each sweep and each run gets a fresh process with its own connection pool
 * that closes when it finishes.
 *
 * ENFORCEMENT IS OPT-IN, and deliberately so. By default every sweep runs in
 * report-only mode: the retention sweep deletes irreplaceable wedding photos,
 * the grace sweep takes away a plan someone paid for, and the notice sweep
 * mails every host whose album is closing. None should ever become a side
 * effect of merely deploying this service. Set RETENTION_ENFORCED=true /
 * GRACE_ENFORCED=true / NOTICE_SEND=true when you actually mean it.
 *
 * Each run's output is also appended to a dated file under MAINTENANCE_LOG_DIR
 * (see runSweep). Report-only mode is only useful if someone can actually read
 * the reports: OPEN_ITEMS.md D1 asks for the retention report to be reviewed
 * repeatedly over weeks before enforcement is ever switched on, and container
 * stdout scrolls away long before that.
 *
 * Those reports are themselves pruned (see pruneOldReports) after
 * MAINTENANCE_LOG_RETENTION_DAYS, default 90 — comfortably longer than the
 * review period D1 asks for, and bounded, which one file per sweep per day
 * forever is not.
 */
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

/** tsx's CLI entry point, resolved from this package rather than from PATH. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

const HOUR_MS = 60 * 60 * 1000;

/**
 * Read an interval from the environment, in hours.
 *
 * Unvalidated `parseInt` is a real hazard here rather than a theoretical one.
 * `RETENTION_INTERVAL_HOURS=0`, a negative, or a typo like `24h` all produce
 * `0` or `NaN`, and `setInterval` treats both as "as fast as possible" — so a
 * single character turns a daily report into a process respawned the instant
 * the previous one exits, hammering the database indefinitely. The `running`
 * guard below keeps it to one at a time, which is precisely what stops it
 * looking like a failure: nothing crashes, it just never stops.
 *
 * Falls back to the default and says so loudly, rather than scheduling
 * something nobody asked for.
 */
export function parseIntervalHours(raw: string | undefined, fallbackHours: number, label: string): number {
  if (raw === undefined || raw.trim() === '') return fallbackHours * HOUR_MS;

  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error(
      `[maintenance] ${label}="${raw}" is not a positive number of hours — falling back to ${fallbackHours}h. ` +
        'Left unchecked this would schedule the sweep to run continuously.'
    );
    return fallbackHours * HOUR_MS;
  }

  return hours * HOUR_MS;
}

export interface Sweep {
  name: string;
  script: string;
  /** The env var that turns this sweep from a report into an action. */
  enforceVar: 'RETENTION_ENFORCED' | 'GRACE_ENFORCED' | 'NOTICE_SEND';
  intervalMs: number;
}

export function buildSweeps(env: NodeJS.ProcessEnv = process.env): Sweep[] {
  return [
    {
      // Warns hosts before the retention sweep can delete anything. Runs on
      // its own daily schedule and ahead of the sweep in this list, because an
      // album has to be warned before it can ever become deletable — the sweep
      // enforces that regardless of ordering, but there is no reason to make a
      // host wait an extra day for a notice that was already due.
      //
      // Opt-in like the others: NOTICE_SEND=true. Unset, it reports who is due
      // and sends nothing, which also means nothing becomes deletable.
      name: 'retention-notice',
      script: 'scripts/retention-notify.ts',
      enforceVar: 'NOTICE_SEND',
      intervalMs: parseIntervalHours(env.NOTICE_INTERVAL_HOURS, 24, 'NOTICE_INTERVAL_HOURS'),
    },
    {
      name: 'subscription-grace',
      script: 'scripts/subscription-grace-sweep.ts',
      enforceVar: 'GRACE_ENFORCED',
      intervalMs: parseIntervalHours(env.GRACE_INTERVAL_HOURS, 1, 'GRACE_INTERVAL_HOURS'),
    },
    {
      name: 'retention',
      script: 'scripts/retention-sweep.ts',
      enforceVar: 'RETENTION_ENFORCED',
      intervalMs: parseIntervalHours(env.RETENTION_INTERVAL_HOURS, 24, 'RETENTION_INTERVAL_HOURS'),
    },
  ];
}

/** Where each run's output is kept, so reports can be reviewed after the fact. */
export function maintenanceLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAINTENANCE_LOG_DIR || path.join(process.cwd(), 'logs', 'maintenance');
}

/** One file per sweep per day, so a fortnight of reports sits side by side. */
export function logFileFor(sweepName: string, when: Date, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(maintenanceLogDir(env), `${sweepName}-${when.toISOString().slice(0, 10)}.log`);
}

/**
 * How long a report is kept. `0` (or "never") keeps them indefinitely.
 *
 * Garbage falls back to the default rather than to zero, so a typo can only
 * ever keep more than intended — never delete more.
 */
export function parseReportRetentionDays(raw: string | undefined, fallbackDays = 90): number {
  if (raw === undefined || raw.trim() === '') return fallbackDays;
  if (raw.trim().toLowerCase() === 'never') return 0;

  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    console.error(
      `[maintenance] MAINTENANCE_LOG_RETENTION_DAYS="${raw}" is not a number of days — ` +
        `falling back to ${fallbackDays}. Use 0 or "never" to keep reports indefinitely.`
    );
    return fallbackDays;
  }

  return days;
}

/**
 * Matches exactly the files this scheduler writes: `<sweep>-YYYY-MM-DD.log`.
 *
 * Deliberately narrow. MAINTENANCE_LOG_DIR is operator-configured and in
 * compose it is a mount point, so this runs against a directory that may hold
 * things nobody asked us to manage. Anything that is not recognisably one of
 * our own dated reports is left alone.
 */
const REPORT_FILE = /^[a-z0-9-]+-(\d{4}-\d{2}-\d{2})\.log$/;

export interface PruneResult {
  removed: string[];
  kept: number;
}

/**
 * Delete reports older than the window.
 *
 * Age comes from the date in the filename, not the file's mtime. They differ:
 * a sweep appends to its file all day, so mtime says "today" for a report that
 * belongs to today, but on a restarted container an older file can also be
 * touched. The filename is the day the report is *about*, which is what a
 * retention window should mean.
 *
 * This is the same shape of problem retention itself exists to solve — one
 * file per sweep per day, forever, on a volume nobody looks at. Small, but
 * unbounded, and the fix is cheap.
 */
export function pruneOldReports(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): PruneResult {
  const result: PruneResult = { removed: [], kept: 0 };
  const retentionDays = parseReportRetentionDays(env.MAINTENANCE_LOG_RETENTION_DAYS);
  if (retentionDays === 0) return result;

  const dir = maintenanceLogDir(env);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // No directory yet is the normal state before the first run, not a fault.
    return result;
  }

  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    const match = REPORT_FILE.exec(entry);
    if (!match) continue;

    // Midnight UTC of the day the report covers. A file is removed only once
    // the whole of its day is outside the window.
    const reportDay = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (Number.isNaN(reportDay) || reportDay >= cutoffMs) {
      result.kept += 1;
      continue;
    }

    try {
      fs.unlinkSync(path.join(dir, entry));
      result.removed.push(entry);
    } catch (err) {
      // A report that cannot be deleted is untidy; failing the scheduler over
      // it would stop the sweeps, which are the actual point.
      console.error(
        `[maintenance] could not remove old report ${entry}:`,
        err instanceof Error ? err.message : err
      );
      result.kept += 1;
    }
  }

  return result;
}

/** Guards against a slow sweep being started again while the last one still runs. */
const running = new Set<string>();

/**
 * Run one sweep to completion.
 *
 * Resolves with the child's exit code rather than returning void, so `--once`
 * can wait for the work and report whether it actually succeeded. The interval
 * path ignores the result, which is the behaviour it had before: a failed sweep
 * must be visible but must never take the scheduler down, because the next tick
 * is a perfectly good retry and a crash loop would stop the other sweeps too.
 */
function runSweep(sweep: Sweep): Promise<number> {
  return new Promise<number>((resolve) => {
    if (running.has(sweep.name)) {
      console.warn(`[maintenance] ${sweep.name} is still running from the last tick — skipping this one`);
      // Not a failure: the previous run is still doing the work.
      resolve(0);
      return;
    }
    running.add(sweep.name);

    const startedAt = new Date();

    // Output goes to this process's stdout (the container log) *and* to a dated
    // file, rather than `stdio: 'inherit'` straight through. A report nobody can
    // read after the fact is not evidence, and deciding whether to enable
    // enforcement depends on having read several weeks of them.
    let logStream: fs.WriteStream | null = null;
    try {
      fs.mkdirSync(maintenanceLogDir(), { recursive: true });
      logStream = fs.createWriteStream(logFileFor(sweep.name, startedAt), { flags: 'a' });
      logStream.write(`\n===== ${sweep.name} @ ${startedAt.toISOString()} =====\n`);
      // A log file that cannot be written must never take the sweep down with
      // it — the sweep is the point, the log is a convenience.
      logStream.on('error', (err) => {
        console.error(`[maintenance] could not write ${sweep.name} log:`, err.message);
        logStream = null;
      });
    } catch (err) {
      console.error(
        `[maintenance] could not open a log file for ${sweep.name}:`,
        err instanceof Error ? err.message : err
      );
      logStream = null;
    }

    // Spawn node directly against tsx's own entry point, rather than the `npx`
    // wrapper. Two reasons, both learned the hard way here: passing args through
    // `shell: true` concatenates instead of escaping them (Node's DEP0190), and
    // dropping the shell to avoid that makes Windows refuse to spawn `npx.cmd`
    // at all (EINVAL — Node will not launch a .cmd without a shell). Resolving
    // the real JS entry point sidesteps both and behaves identically on Linux,
    // which is where this actually runs.
    const child = spawn(process.execPath, [TSX_CLI, sweep.script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      logStream?.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      logStream?.write(chunk);
    });

    const finish = (line: string): void => {
      logStream?.end(`${line}\n`);
      logStream = null;
    };

    child.on('exit', (code) => {
      running.delete(sweep.name);
      const seconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
      // A failed sweep must be visible but must not take the scheduler down with
      // it — the next tick is a perfectly good retry, and a crash loop here would
      // stop the OTHER sweep running too.
      if (code === 0) {
        const line = `[maintenance] ${sweep.name} finished in ${seconds}s`;
        console.log(line);
        finish(line);
      } else {
        const line = `[maintenance] ${sweep.name} exited with code ${code} after ${seconds}s`;
        console.error(line);
        finish(line);
      }
      // Resolved after the log line is handed to the stream, so `--once` never
      // beats its own last report to the file.
      resolve(code ?? 1);
    });

    child.on('error', (err) => {
      running.delete(sweep.name);
      const line = `[maintenance] ${sweep.name} could not start: ${err.message}`;
      console.error(line);
      finish(line);
      resolve(1);
    });
  });
}

/** Reports are pruned daily; there is nothing to gain from checking more often. */
const PRUNE_INTERVAL_MS = 24 * HOUR_MS;

function prune(): void {
  const { removed, kept } = pruneOldReports();
  if (removed.length > 0) {
    console.log(`[maintenance] removed ${removed.length} report(s) past the retention window, kept ${kept}`);
  }
}

/** `--once` anywhere in the arguments; everything else is ignored. */
export function parseOnce(argv: string[]): boolean {
  return argv.includes('--once');
}

export type SweepRunner = (sweep: Sweep) => Promise<number>;

/**
 * Run every sweep once, in order, and report how many failed.
 *
 * Sequential rather than concurrent, unlike the scheduler's boot burst. Two
 * reasons: the notice sweep genuinely should precede the retention sweep — an
 * album has to be warned before it can become deletable — and one sweep at a
 * time means one connection pool at a time, which matters when this is run
 * from cron on a small database.
 *
 * The runner is injectable so the ordering and exit-code accounting can be
 * tested without spawning three real processes against a live database.
 */
export async function runAllOnce(sweeps: Sweep[], run: SweepRunner = runSweep): Promise<number> {
  let failures = 0;
  for (const sweep of sweeps) {
    if ((await run(sweep)) !== 0) failures += 1;
  }
  return failures;
}

/** Shared by both modes, so the plan is stated the same way whichever is used. */
function logPlan(sweeps: Sweep[], scheduled: boolean): void {
  const retentionDays = parseReportRetentionDays(process.env.MAINTENANCE_LOG_RETENTION_DAYS);
  console.log(`[maintenance] reports are kept in ${maintenanceLogDir()}`);
  console.log(
    retentionDays === 0
      ? '[maintenance] reports are kept indefinitely (MAINTENANCE_LOG_RETENTION_DAYS=0)'
      : `[maintenance] reports older than ${retentionDays} days are removed`
  );

  for (const sweep of sweeps) {
    const enforcing = process.env[sweep.enforceVar] === 'true';
    const cadence = scheduled
      ? `every ${(sweep.intervalMs / HOUR_MS).toFixed(1).replace(/\.0$/, '')}h`
      : 'once';
    console.log(
      `[maintenance]   ${sweep.name}: ${cadence}, ` +
        `${enforcing ? 'ENFORCING' : `report-only (set ${sweep.enforceVar}=true to act)`}`
    );
  }
}

/**
 * Run everything once and exit — for cron, for a one-shot container, and for
 * checking by hand what the sweeps currently say.
 *
 *   npm run maintenance:once
 *
 * Exits non-zero if any sweep did, which is the whole point of having it: a
 * sweep that fails silently under cron is the classic way for this kind of job
 * to stop working without anybody noticing.
 */
export async function runOnce(): Promise<void> {
  const sweeps = buildSweeps();
  console.log('[maintenance] running every sweep once, then exiting');
  logPlan(sweeps, false);

  prune();
  const failures = await runAllOnce(sweeps);

  if (failures > 0) {
    console.error(`[maintenance] ${failures} of ${sweeps.length} sweep(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`[maintenance] all ${sweeps.length} sweep(s) finished`);
}

export function startScheduler(): void {
  const sweeps = buildSweeps();
  console.log('[maintenance] scheduler started');
  logPlan(sweeps, true);

  prune();
  setInterval(prune, PRUNE_INTERVAL_MS);

  for (const sweep of sweeps) {
    // Run once at boot so a deploy surfaces the current position immediately,
    // rather than the first signal arriving an hour or a day later. The result
    // is deliberately ignored here — see runSweep.
    void runSweep(sweep);
    setInterval(() => void runSweep(sweep), sweep.intervalMs);
  }
}

// Only start when run as a script. Importing this module — which the tests do,
// to exercise the interval parsing that used to be unreachable — must not
// spawn sweeps against a live database. Same guard as server/lib/migrate.ts.
const invokedDirectly =
  process.argv[1] !== undefined && /maintenance-scheduler\.[tj]s$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  if (parseOnce(process.argv.slice(2))) {
    // No intervals are registered in this mode, so the process ends on its own
    // once the sweeps have finished.
    void runOnce();
  } else {
    startScheduler();
  }
}
