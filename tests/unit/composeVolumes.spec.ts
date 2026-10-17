import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * The compose file's volume names, which nothing else checks.
 *
 * `maintenance_logs` was declared as `name: wedmoments_postgres_data` — the
 * Postgres volume's name — because the entry was inserted directly above a
 * `name:` line that belonged to `postgres_data`, orphaning it. Two things
 * follow, and neither announces itself:
 *
 *   1. The maintenance container mounts the database's data volume at
 *      /app/logs and appends sweep reports into PGDATA.
 *   2. `postgres_data` falls back to a name Compose derives from the project,
 *      which defaults to the containing directory. Checked out as
 *      "Wedding_album" rather than "wedmoments" the database comes up against
 *      an empty volume, which presents as every album having vanished.
 *
 * It was caught before the maintenance service had ever been brought up — the
 * volume listing showed no `wedmoments_maintenance_logs`, and PGDATA held no
 * stray `.log` files. There is no type checker for YAML, so this stands in.
 */

const COMPOSE_PATH = path.join(process.cwd(), 'docker-compose.yml');

interface ComposeFile {
  services: Record<string, { volumes?: string[] }>;
  volumes: Record<string, { name?: string } | null>;
}

function loadCompose(): ComposeFile {
  return yaml.load(fs.readFileSync(COMPOSE_PATH, 'utf8')) as ComposeFile;
}

describe('docker-compose volumes', () => {
  it('gives every volume an explicit name', () => {
    // Without `name:`, the volume's real identity depends on the directory the
    // repository happens to sit in.
    const volumes = loadCompose().volumes;

    for (const [key, value] of Object.entries(volumes)) {
      expect({ key, named: typeof value?.name === 'string' && value.name.length > 0 }).toEqual({
        key,
        named: true,
      });
    }
  });

  it('names each volume after itself', () => {
    // The rule that catches the copy-paste directly: a volume's name must end
    // in its own key. `maintenance_logs: { name: wedmoments_postgres_data }`
    // breaks it on sight.
    //
    // Comparing declared names for collisions is not enough on its own, and
    // that is worth spelling out: the orphaned `name:` also leaves
    // `postgres_data` with no name at all, which parses as null — so the two
    // entries no longer "collide", they disagree, and a uniqueness check waves
    // the real defect straight through.
    const volumes = loadCompose().volumes;

    for (const [key, value] of Object.entries(volumes)) {
      expect({ key, name: value?.name, matches: value?.name?.endsWith(key) ?? false }).toEqual({
        key,
        name: value?.name,
        matches: true,
      });
    }
  });

  it('never points two volumes at the same underlying name', () => {
    const volumes = loadCompose().volumes;
    // Falls back to the key so a missing name cannot masquerade as unique.
    const names = Object.entries(volumes).map(([key, value]) => value?.name ?? key);

    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the database volume on the name the running stack already uses', () => {
    // Renaming this silently swaps in an empty database, so it is pinned
    // rather than merely required to be unique.
    expect(loadCompose().volumes.postgres_data?.name).toBe('wedmoments_postgres_data');
  });

  it('mounts every volume a service asks for', () => {
    const compose = loadCompose();
    const declared = new Set(Object.keys(compose.volumes));

    for (const [service, config] of Object.entries(compose.services)) {
      for (const mount of config.volumes ?? []) {
        // A source may be a variable with a default, `${BACKUP_DIR:-./backups}`:
        // read as its default, or its own `:-` would split it.
        const source = mount.replace(/\$\{\w+:-([^}]*)\}/g, '$1').split(':')[0];
        // Bind mounts (./x:/y) are paths, not named volumes.
        if (source.startsWith('.') || source.startsWith('/')) continue;
        expect({ service, source, declared: declared.has(source) }).toEqual({
          service,
          source,
          declared: true,
        });
      }
    }
  });

  it('keeps the maintenance reports off the database volume', () => {
    // The specific pairing that was wrong, named so a reintroduction reads as
    // itself rather than as a generic uniqueness failure. Asserted against the
    // database volume's pinned name rather than against whatever
    // `postgres_data` currently says, because the way this broke left that
    // entry with nothing to compare to.
    const volumes = loadCompose().volumes;

    expect(volumes.maintenance_logs?.name).not.toBe('wedmoments_postgres_data');
    expect(volumes.maintenance_logs?.name).not.toBe(volumes.uploads_data?.name);
  });
});

/**
 * N-69 — under local storage, photos awaiting moderation and photos locked
 * until a disposable album's reveal sit in QUARANTINE_DIR, not in the uploads
 * directory. Compose mounted a volume for the uploads only, so those files
 * lived in the container's writable layer and were lost on any recreate:
 * every image rebuild and every `docker compose up` that changed the service.
 */
describe('the quarantine directory (N-69)', () => {
  interface Service {
    volumes?: string[];
    environment?: Record<string, string>;
  }

  function servicesWithUploads(): [string, Service][] {
    const services = loadCompose().services as Record<string, Service>;
    return Object.entries(services).filter(([, s]) => (s.volumes ?? []).some((m) => m.startsWith('uploads_data:')));
  }

  it('is set explicitly wherever the uploads are mounted', () => {
    // Its default is relative to the working directory; a volume mounted at a
    // guessed path is the same loss again if the default ever moves.
    for (const [service, config] of servicesWithUploads()) {
      expect({ service, dir: config.environment?.QUARANTINE_DIR }).toEqual({
        service,
        dir: expect.stringMatching(/^\//),
      });
    }
  });

  it('lives on a named volume of its own wherever the uploads are mounted', () => {
    const declared = new Set(Object.keys(loadCompose().volumes));

    for (const [service, config] of servicesWithUploads()) {
      const dir = config.environment?.QUARANTINE_DIR;
      const mount = (config.volumes ?? []).find((m) => m.split(':')[1] === dir);
      const source = mount?.split(':')[0];
      expect({ service, source, named: !!source && declared.has(source), own: source !== 'uploads_data' }).toEqual({
        service,
        source: expect.any(String),
        named: true,
        own: true,
      });
    }
  });

  it('is not inside the uploads directory, which is served to anyone', () => {
    for (const [service, config] of servicesWithUploads()) {
      const uploads = config.environment?.UPLOADS_DIR ?? '';
      const dir = config.environment?.QUARANTINE_DIR ?? '';
      expect({ service, inside: dir === uploads || dir.startsWith(`${uploads}/`) }).toEqual({ service, inside: false });
    }
  });
});
