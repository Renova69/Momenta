/**
 * Running PostgreSQL's own client tools (pg_dump, pg_restore) against the
 * app's database, for the backup and the restore check.
 *
 * Two ways to reach them, because the app runs two ways (docs/DEPLOYMENT.md):
 *
 * - `local`: the tools are installed where this runs, and connect with
 *   DATABASE_URL. A managed database (Neon, Supabase) is reached this way.
 * - `docker`: the tools inside the database's own container, which always
 *   match its server version. The shipped compose names it `wedmoments-db`.
 *
 * The password never goes on a command line, where other users of the machine
 * could read it from the process list: it is handed over in the environment
 * (PGPASSWORD) in local mode, and not needed at all inside the container,
 * whose local socket the official image trusts.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';

export type PgToolMode = 'local' | 'docker';

export interface PgTarget {
  mode: PgToolMode;
  /** Database name, from DATABASE_URL. */
  database: string;
  /** Role, from DATABASE_URL. */
  user: string;
  /** The container, in docker mode. */
  container: string;
  /** libpq environment for local mode; never printed. */
  env: NodeJS.ProcessEnv;
}

export const DEFAULT_CONTAINER = 'wedmoments-db';

/**
 * libpq environment variables for a connection string, so the password is
 * passed in the environment rather than on a command line.
 */
export function libpqEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** The same connection string, naming another database on the same server. */
export function withDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/** The major version a pg tool reports, e.g. 16 for "pg_dump (PostgreSQL) 16.4". */
export function toolMajorVersion(versionOutput: string): number | null {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(versionOutput);
  return match ? Number(match[1]) : null;
}

function localToolMajor(tool: string): number | null {
  const out = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  if (out.error || out.status !== 0) return null;
  return toolMajorVersion(out.stdout);
}

function containerRunning(container: string): boolean {
  const out = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8' });
  return !out.error && out.status === 0 && out.stdout.trim() === 'true';
}

/**
 * Whether any pg_dump can be reached here: installed, or in the database's
 * container. Says nothing about versions; resolvePgTarget decides that.
 */
export function pgToolsReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  return localToolMajor('pg_dump') !== null || containerRunning(env.BACKUP_PG_CONTAINER || DEFAULT_CONTAINER);
}

/**
 * Pick how to run the tools. pg_dump refuses a server newer than itself, so
 * local tools are used only when they are at least the server's version.
 */
export function resolvePgTarget(databaseUrl: string, serverMajor: number, env: NodeJS.ProcessEnv = process.env): PgTarget {
  const requested = (env.BACKUP_PG_TOOLS || 'auto').toLowerCase();
  const container = env.BACKUP_PG_CONTAINER || DEFAULT_CONTAINER;
  const conn = libpqEnv(databaseUrl);
  const base = { database: conn.PGDATABASE, user: conn.PGUSER, container };

  const localMajor = requested === 'docker' ? null : localToolMajor('pg_dump');
  if (requested === 'local' || (requested === 'auto' && localMajor !== null && localMajor >= serverMajor)) {
    if (localMajor === null) throw new Error('BACKUP_PG_TOOLS=local, but pg_dump is not installed here.');
    if (localMajor < serverMajor) {
      throw new Error(`pg_dump here is version ${localMajor}; the server is ${serverMajor}. Install a newer client or use BACKUP_PG_TOOLS=docker.`);
    }
    return { ...base, mode: 'local', env: { ...process.env, ...conn } };
  }
  if (containerRunning(container)) return { ...base, mode: 'docker', env: process.env };

  throw new Error(
    `No usable pg_dump: none installed here at version ${serverMajor} or later, and no running container "${container}". ` +
      'Install the PostgreSQL client tools, or set BACKUP_PG_CONTAINER to the database container.'
  );
}

/** The command line for one tool run, in either mode. */
export function toolCommand(target: PgTarget, tool: 'pg_dump' | 'pg_restore', args: string[]): { command: string; args: string[] } {
  if (target.mode === 'local') return { command: tool, args };
  return { command: 'docker', args: ['exec', '-i', target.container, tool, '-U', target.user, ...args] };
}

/** Run a tool, its standard output written to a file. Rejects with its error output. */
export function runToFile(target: PgTarget, tool: 'pg_dump' | 'pg_restore', args: string[], outFile: string): Promise<void> {
  const { command, args: argv } = toolCommand(target, tool, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env: target.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(outFile);
    let stderr = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      out.end(() => (code === 0 ? resolve() : reject(new Error(`${tool} failed (${code}): ${stderr.trim()}`))));
    });
  });
}

/** Run a tool with a file on its standard input. Resolves with its standard output. */
export function runFromFile(target: PgTarget, tool: 'pg_dump' | 'pg_restore', args: string[], inFile: string): Promise<string> {
  const { command, args: argv } = toolCommand(target, tool, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env: target.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${tool} failed (${code}): ${stderr.trim()}`))));
    fs.createReadStream(inFile).pipe(child.stdin);
  });
}
