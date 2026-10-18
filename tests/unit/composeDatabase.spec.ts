import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * N-167 — the database was published on every interface with a password
 * committed to this repository.
 *
 * `"${DB_PORT:-6532}:5432"` binds 0.0.0.0, and Docker's published ports bypass
 * a Linux host's ufw rules. `POSTGRES_PASSWORD` fell back to
 * `postgrespassword` in four services, while the same file already refused to
 * start without JWT_SECRET. Whoever reached the port could read every album,
 * guest and payment row. Checked here because nothing type-checks YAML.
 */

const COMPOSE_TEXT = fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');

interface ComposeService {
  ports?: string[];
}

const compose = yaml.load(COMPOSE_TEXT) as { services: Record<string, ComposeService> };

describe('docker-compose database exposure (N-167)', () => {
  it('never falls back to a default database password', () => {
    expect(COMPOSE_TEXT).not.toContain('postgrespassword');
    // Every use of the password must be the required form, `${POSTGRES_PASSWORD:?...}`.
    const uses = COMPOSE_TEXT.match(/\$\{POSTGRES_PASSWORD[^}]*\}/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const use of uses) expect(use.startsWith('${POSTGRES_PASSWORD:?')).toBe(true);
  });

  it('publishes the database port on the loopback interface only', () => {
    const ports = compose.services.db.ports ?? [];
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port.startsWith('127.0.0.1:')).toBe(true);
  });
});
