import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * N-83 — the production image ran the server with a `tsx` installed globally
 * at build time, with no version: whatever npm served that day, unrelated to
 * the one the lockfile pins and the tests ran under. And CI never built the
 * image, so a Dockerfile that no longer built was found on deploy.
 *
 * These read the files rather than run Docker: they pin the decisions, and the
 * CI job they require is what builds the image.
 */

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('the runtime the production image starts the server with (N-83)', () => {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dockerfile = read('Dockerfile');

  it('is a production dependency, so the locked version is the one installed', () => {
    expect(pkg.dependencies.tsx).toBeDefined();
    expect(pkg.devDependencies?.tsx).toBeUndefined();
  });

  it('is not installed globally at build time', () => {
    const instructions = dockerfile
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(instructions).not.toMatch(/npm (install|i) +(-g|--global)/);
  });

  it('is started from the project, not through npx', () => {
    // Directly, so the server receives the stop signal (N-66) rather than an
    // npm process standing in front of it.
    const cmd = dockerfile.match(/^CMD (.+)$/m)?.[1] ?? '';
    expect(JSON.parse(cmd)).toEqual(['node_modules/.bin/tsx', 'server/index.ts']);
  });

  it('starts the maintenance scheduler the same way', () => {
    const compose = yaml.load(read('docker-compose.yml')) as {
      services: Record<string, { command?: string[] }>;
    };
    expect(compose.services.maintenance.command?.[0]).toBe('node_modules/.bin/tsx');
  });
});

describe('the image in CI (N-83)', () => {
  it('is built on every run', () => {
    const workflow = yaml.load(read('.github/workflows/ci.yml')) as {
      on: Record<string, unknown>;
      jobs: Record<string, { if?: string; steps: { run?: string }[] }>;
    };
    const building = Object.entries(workflow.jobs).filter(([, job]) =>
      job.steps.some((step) => /docker build\b/.test(step.run ?? ''))
    );

    expect(building.map(([name]) => name)).toHaveLength(1);
    // Not only on a schedule: a broken Dockerfile should fail the change that broke it.
    expect(building[0][1].if).toBeUndefined();
  });
});
