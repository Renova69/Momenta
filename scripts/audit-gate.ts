/**
 * Dependency audit gate.
 *
 *   npm run audit:ci
 *
 * `npm audit` has two settings and neither is usable on its own in CI: gate on
 * everything and the build is red until every advisory in the ecosystem is
 * fixed, including ones that cannot be and ones that are not reachable; gate on
 * nothing and the check is decoration. A permanently red check is worse than no
 * check, because people learn to scroll past it.
 *
 * So this gates on production advisories at or above the threshold, with a
 * written allowlist. An entry has to say why it is acceptable and who decided,
 * which is the part a `--audit-level` flag cannot express.
 *
 * Two failure directions, deliberately:
 *
 *  - a new advisory that is not in the allowlist fails the run;
 *  - an allowlist entry whose advisory has *gone* also fails it, so the list
 *    cannot quietly rot into a set of permanent exemptions nobody rechecks.
 *
 * Dev dependencies are excluded. A vulnerability in a bundler does not reach a
 * guest; one in an upload parser does.
 */

import { execSync } from 'child_process';

/** Fail on this severity and above. */
const THRESHOLD: Severity = 'high';

type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

const SEVERITY_ORDER: Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];

interface AllowedAdvisory {
  /** The package as npm audit names it. */
  name: string;
  /** GHSA id, so the entry survives the advisory being retitled. */
  advisory: string;
  /** Why this does not need to block a release. Specific, and checkable. */
  reason: string;
  /** When a person last confirmed the reasoning still holds. */
  reviewed: string;
}

/**
 * Accepted production advisories.
 *
 * Keep this short. An entry is a claim that someone checked, not a way to make
 * the output quiet.
 */
const ALLOWLIST: AllowedAdvisory[] = [
  {
    name: 'ip',
    advisory: 'GHSA-2p57-rm9w-gvfp',
    reason:
      'SSRF via misclassification in ip.isPublic(). No fixed version exists — the ' +
      'advisory covers <=2.0.1 and 2.0.1 is the latest release; the package is ' +
      'unmaintained. Not reachable here: it arrives only through ftp-srv, which calls ' +
      'ip.isEqual() and nothing else (node_modules/ftp-srv/src/connector/active.js:32, ' +
      'passive.js:39), and no code in this repository imports ip directly. isEqual is ' +
      'itself a security check there — it refuses a data connection whose peer differs ' +
      'from the control connection. Revisit if ftp-srv is upgraded or replaced.',
    reviewed: '2026-09-12',
  },
  {
    name: 'ftp-srv',
    advisory: 'GHSA-2p57-rm9w-gvfp',
    reason:
      'Reported only because it depends on ip, above. ftp-srv has no advisory of its ' +
      'own, and npm audit\'s suggested fix (ftp-srv@2.16.2) is a two-major downgrade ' +
      'of a direct dependency, which trades a theoretical issue for a real loss of ' +
      'function. Same review trigger as the ip entry.',
    reviewed: '2026-09-12',
  },
];

interface AuditAdvisory {
  severity: Severity;
  url?: string;
  title?: string;
}

interface AuditVulnerability {
  name: string;
  severity: Severity;
  isDirect?: boolean;
  via?: (string | AuditAdvisory)[];
}

interface AuditReport {
  vulnerabilities?: Record<string, AuditVulnerability>;
}

function meetsThreshold(severity: Severity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(THRESHOLD);
}

/**
 * `npm audit` exits non-zero whenever it finds anything, so a non-zero exit is
 * not an error here — only unparseable output is.
 */
function runAudit(): AuditReport {
  let raw: string;
  try {
    // A shell, deliberately: on Windows npm is a .cmd shim that Node will not
    // spawn directly, and passing an argument array alongside `shell: true` is
    // deprecated. The command is a constant in this file, so there is no input
    // for a shell to interpolate.
    raw = execSync('npm audit --omit=dev --json', {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const output = (err as { stdout?: string }).stdout;
    if (!output) {
      console.error('[audit] npm audit produced no output:', (err as Error).message);
      process.exit(1);
    }
    raw = output;
  }

  try {
    return JSON.parse(raw) as AuditReport;
  } catch {
    console.error('[audit] could not parse npm audit output as JSON.');
    process.exit(1);
  }
}

function advisoryIdsFor(vuln: AuditVulnerability): string[] {
  return (vuln.via ?? [])
    .filter((v): v is AuditAdvisory => typeof v === 'object')
    .map((v) => v.url?.split('/').pop() ?? '')
    .filter(Boolean);
}

function main(): void {
  const report = runAudit();
  const vulns = Object.values(report.vulnerabilities ?? {});

  const gating = vulns.filter((v) => meetsThreshold(v.severity));
  const allowedNames = new Set(ALLOWLIST.map((a) => a.name));

  const unexpected = gating.filter((v) => !allowedNames.has(v.name));
  const matchedNames = new Set(gating.map((v) => v.name));
  const stale = ALLOWLIST.filter((a) => !matchedNames.has(a.name));

  console.log(
    `[audit] production dependencies, gating at "${THRESHOLD}" and above: ` +
      `${gating.length} advisory(ies) found, ${ALLOWLIST.length} allowlisted.`
  );

  for (const entry of ALLOWLIST) {
    if (matchedNames.has(entry.name)) {
      console.log(`[audit] allowed: ${entry.name} (${entry.advisory}, reviewed ${entry.reviewed})`);
    }
  }

  if (stale.length > 0) {
    console.error(
      '\n[audit] These allowlist entries no longer match any advisory. They have been ' +
        'fixed, or the package is gone. Remove them from scripts/audit-gate.ts — an ' +
        'allowlist that outlives its reason is how a real advisory gets waved through ' +
        'later:'
    );
    for (const entry of stale) console.error(`  - ${entry.name} (${entry.advisory})`);
  }

  if (unexpected.length > 0) {
    console.error(`\n[audit] ${unexpected.length} unreviewed advisory(ies) at ${THRESHOLD} or above:\n`);
    for (const vuln of unexpected) {
      const ids = advisoryIdsFor(vuln);
      console.error(`  ${vuln.severity.toUpperCase()}  ${vuln.name}${vuln.isDirect ? ' (direct)' : ''}`);
      for (const id of ids) console.error(`         https://github.com/advisories/${id}`);
    }
    console.error(
      '\n[audit] Fix it, or add it to ALLOWLIST in scripts/audit-gate.ts with a reason ' +
        'that says why it is not reachable here. "It is only moderate" is not a reason.'
    );
  }

  if (unexpected.length > 0 || stale.length > 0) process.exit(1);

  console.log('[audit] No unreviewed production advisories.');
}

main();
