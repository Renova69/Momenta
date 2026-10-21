import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

/**
 * The compose `backup` service's loop, scripts/backup-loop.sh, sourced with
 * BACKUP_LIB_ONLY=1 so its functions run without the loop or a database.
 *
 * N-177 — BACKUP_KEEP=0 ("keep all" to many tools) pruned with `tail -n +1`
 * and removed every dump, the new one included; a value that was not a number
 * counted as 0.
 * N-178 — a failed backup waited a whole interval, and every restart backed
 * up again, so a day of restarts pushed out the earlier days.
 * N-187 — the dumps were root's alone; BACKUP_UID hands them to the operator.
 */

const SCRIPT = path.join(process.cwd(), 'scripts', 'backup-loop.sh').replace(/\\/g, '/');
const shAvailable = spawnSync('sh', ['-c', 'stat -c %Y . >/dev/null && echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

let dir = '';

function source(script: string, env: Record<string, string> = {}) {
  const result = spawnSync('sh', ['-c', `. "${SCRIPT}"; ${script}`], {
    encoding: 'utf8',
    env: { ...process.env, BACKUP_LIB_ONLY: '1', BACKUP_TARGET_DIR: dir, ...env },
  });
  return { out: result.stdout.trim(), err: result.stderr.trim(), status: result.status };
}

function dumps(): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.dump')).sort();
}

function writeDumps(count: number): void {
  for (let i = 0; i < count; i++) {
    const name = `wedmoments-2026-10-${String(10 + i).padStart(2, '0')}T03-00-00Z.dump`;
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.writeFileSync(path.join(dir, `${name}.json`), '{}');
  }
}

describe.runIf(shAvailable)('the backup loop (scripts/backup-loop.sh)', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-backup-loop-')).replace(/\\/g, '/');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the newest BACKUP_KEEP dumps and their manifests', () => {
    writeDumps(5);
    source('prune', { BACKUP_KEEP: '2' });
    expect(dumps()).toEqual(['wedmoments-2026-10-13T03-00-00Z.dump', 'wedmoments-2026-10-14T03-00-00Z.dump']);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(2);
  });

  it('does not take BACKUP_KEEP=0 as a licence to delete every dump (N-177)', () => {
    writeDumps(5);
    const { err } = source('prune', { BACKUP_KEEP: '0' });
    expect(dumps()).toHaveLength(5);
    expect(err).toMatch(/BACKUP_KEEP/);
  });

  it('falls back to 14 for a value that is not a number', () => {
    writeDumps(3);
    expect(source('echo "$KEEP"', { BACKUP_KEEP: 'all' }).out.split('\n').pop()).toBe('14');
    source('prune', { BACKUP_KEEP: 'all' });
    expect(dumps()).toHaveLength(3);
  });

  it('waits out the rest of the interval after a restart, not a whole one (N-178)', () => {
    expect(source('seconds_until_due').out).toBe('0');

    writeDumps(1);
    const fresh = Number(source('seconds_until_due', { BACKUP_INTERVAL_HOURS: '24' }).out);
    expect(fresh).toBeGreaterThan(23 * 3600);
    expect(fresh).toBeLessThanOrEqual(24 * 3600);

    const old = path.join(dir, dumps()[0]);
    const twoDaysAgo = (Date.now() - 48 * 3600 * 1000) / 1000;
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    expect(source('seconds_until_due', { BACKUP_INTERVAL_HOURS: '24' }).out).toBe('0');
  });

  it('tries a failed backup again before giving up until the next interval (N-178)', () => {
    const { out, err, status } = source(
      'calls=0; backup_once() { calls=$((calls + 1)); return 1; }; sleep() { :; }; backup_with_retries; echo "$? $calls"',
      { BACKUP_ATTEMPTS: '3' }
    );
    expect(status).toBe(0);
    expect(out.split('\n').pop()).toBe('1 3');
    expect(err.match(/FAILED/g)).toHaveLength(3);
  });

  it('hands the files to BACKUP_UID only when it is set (N-187)', () => {
    expect(source('chown() { echo "chown $*"; }; hand_over a b').out).toBe('');
    expect(source('chown() { echo "chown $*"; }; hand_over a b', { BACKUP_UID: '1000' }).out).toBe('chown 1000:1000 a b');
  });

  // N-202 — the shell reads 08 in $(( )) as an octal number it cannot parse:
  // BACKUP_KEEP=08 pruned nothing, and BACKUP_INTERVAL_HOURS=08 crashed the
  // loop after every backup, so each restart backed up again.
  it('reads a leading zero as the number it is (N-202)', () => {
    writeDumps(10);
    const { err } = source('prune', { BACKUP_KEEP: '08' });
    expect(dumps()).toHaveLength(8);
    expect(err).not.toMatch(/BACKUP_KEEP/);

    expect(source('echo "$INTERVAL_HOURS $((INTERVAL_HOURS * 3600))"', { BACKUP_INTERVAL_HOURS: '08' }).out).toBe('8 28800');
    expect(source('echo "$KEEP"', { BACKUP_KEEP: '00' }).out.split('\n').pop()).toBe('14');
  });

  // N-205 — when every attempt failed, a log line was all that said so: the
  // container stayed "Up" with no health state for monitoring to see.
  it('reports itself unhealthy once the newest dump is older than an interval and its retries (N-205)', () => {
    const env = { BACKUP_INTERVAL_HOURS: '24', BACKUP_ATTEMPTS: '4', BACKUP_RETRY_MINUTES: '15' };
    expect(source('health', env).status).not.toBe(0);

    writeDumps(1);
    expect(source('health', env).status).toBe(0);

    const newest = path.join(dir, dumps()[0]);
    const late = (Date.now() - 27 * 3600 * 1000) / 1000;
    fs.utimesSync(newest, late, late);
    const stale = source('health', env);
    expect(stale.status).not.toBe(0);
    expect(stale.out).toMatch(/27h/);
  });
});

// N-203 — compose passes a container only the variables it names. The script
// read BACKUP_RETRY_MINUTES and BACKUP_ATTEMPTS, documented as settings, and
// never received them.
describe('the compose backup service', () => {
  const compose = yaml.load(fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8')) as {
    services: Record<string, { environment?: Record<string, string>; healthcheck?: { test?: string[] } }>;
  };
  const service = compose.services.backup;
  const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'backup-loop.sh'), 'utf8');
  // Set by hand or by the tests, never by the service.
  const NOT_SETTINGS = new Set(['BACKUP_LIB_ONLY', 'BACKUP_ONCE', 'BACKUP_TARGET_DIR']);

  it('passes every setting the loop reads (N-203)', () => {
    const read = [...new Set([...script.matchAll(/\$\{(BACKUP_[A-Z_]+)/g)].map((m) => m[1]))].filter((v) => !NOT_SETTINGS.has(v));
    expect(read.length).toBeGreaterThan(4);
    for (const name of read) expect(Object.keys(service.environment ?? {}), name).toContain(name);
  });

  it('checks its own health with the loop (N-205)', () => {
    expect(service.healthcheck?.test?.join(' ')).toMatch(/backup-loop\.sh health/);
  });
});
