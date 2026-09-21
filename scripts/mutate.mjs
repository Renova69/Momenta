/**
 * Mutation sweep for the client.
 *
 * Apply one small semantic change to a module, run every spec that reaches it,
 * and record whether any failed. A mutation that survives is a behaviour
 * nothing asserts.
 *
 *   npm run mutate -- src/services/photoService.ts [--limit N] [--list]
 *
 * One at a time: two sweeps at once run two vitest processes against one
 * database, and a spec that fails for that reason is recorded as a mutation
 * caught — a false kill, which inflates the score silently.
 *
 * Three guards, each for a way the previous sweep was lied to:
 *  - canary: corrupt the module outright first; if the selected specs still
 *    pass, the selection is wrong and nothing is reported.
 *  - invalid mutations (a syntax error) are separated from kills, because a
 *    module that will not parse fails every spec and looks like a kill.
 *  - the spec set is the transitive importers, not the direct ones.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').split(path.sep).join('/');
const target = process.argv[2];
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const LIST_ONLY = process.argv.includes('--list');
if (!target) throw new Error('usage: node mutate.mjs <module path relative to repo root>');

// ---------- import graph

const SRC_GLOBS = ['src', 'shared', 'tests/unit', 'tests/helpers'];
const files = [];
for (const dir of SRC_GLOBS) walk(path.join(ROOT, dir));
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p.replace(/\\/g, '/'));
  }
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
const edges = new Map(); // file -> Set(resolved files it imports)
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const out = new Set();
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const resolved = resolve(path.dirname(f), spec);
    if (resolved) out.add(resolved);
  }
  edges.set(f, out);
}

function resolve(fromDir, spec) {
  const base = path.resolve(fromDir, spec).replace(/\\/g, '/');
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

const TARGET = path.resolve(ROOT, target).replace(/\\/g, '/');
if (!fs.existsSync(TARGET)) throw new Error(`no such module: ${TARGET}`);

// Specs that reach the target transitively.
const specs = files
  .filter((f) => /tests\/unit\/.*\.spec\.(ts|tsx)$/.test(f))
  .filter((spec) => reaches(spec, TARGET));

function reaches(from, goal) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === goal) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) || []) stack.push(next);
  }
  return false;
}

const specArgs = specs.map((s) => path.relative(ROOT, s).replace(/\\/g, '/'));
console.log(`[sweep] ${target}`);
console.log(`[sweep] ${specArgs.length} spec file(s) reach it`);
if (specArgs.length === 0) {
  console.log('[sweep] NO SPECS REACH THIS MODULE — nothing to sweep, and that is itself the finding.');
  process.exit(0);
}

// ---------- mutations

const ORIGINAL = fs.readFileSync(TARGET, 'utf8');
const lines = ORIGINAL.split('\n');

const OPS = [
  ['===', '!=='],
  ['!==', '==='],
  ['>=', '>'],
  ['<=', '<'],
  ['&&', '||'],
  ['||', '&&'],
  ['??', '||'],
];

const mutations = [];
lines.forEach((line, i) => {
  const code = line.split('//')[0];
  if (!code.trim() || code.trim().startsWith('*')) return;
  for (const [from, to] of OPS) {
    let cursor = code.indexOf(from);
    while (cursor !== -1) {
      // `at` must be a fresh binding per mutation. Closing over the loop
      // variable handed every mutation the loop's final value, -1, so each one
      // wrote a mangled line that would not parse — and the run reported a
      // broken module instead of the mutation it was meant to be.
      const at = cursor;
      // Skip a >= that is really part of => .
      if (!(from === '>=' && code[at - 1] === '=')) {
        mutations.push({
          line: i + 1,
          from,
          to,
          apply: () => {
            const next = [...lines];
            next[i] = line.slice(0, at) + to + line.slice(at + from.length);
            return next.join('\n');
          },
          preview: `${from} -> ${to}  ${code.trim().slice(0, 90)}`,
        });
      }
      cursor = code.indexOf(from, at + from.length);
    }
  }
  // Boolean literals, but only where they are a value, not part of a word.
  for (const [from, to] of [['true', 'false'], ['false', 'true']]) {
    const re = new RegExp(`\\b${from}\\b`, 'g');
    for (const m of code.matchAll(re)) {
      const at = m.index;
      mutations.push({
        line: i + 1,
        from,
        to,
        apply: () => {
          const next = [...lines];
          next[i] = line.slice(0, at) + to + line.slice(at + from.length);
          return next.join('\n');
        },
        preview: `${from} -> ${to}  ${code.trim().slice(0, 90)}`,
      });
    }
  }
});

console.log(`[sweep] ${mutations.length} candidate mutation(s)`);
if (LIST_ONLY) {
  mutations.forEach((m, n) => console.log(`  ${n} L${m.line}  ${m.preview}`));
  process.exit(0);
}

// ---------- run

function runSpecs() {
  try {
    execFileSync(
      'npx',
      ['cross-env', 'STORAGE_PROVIDER=local', 'vitest', 'run', ...specArgs, '--reporter=dot'],
      { cwd: ROOT, stdio: 'pipe', shell: true, timeout: 20 * 60 * 1000 }
    );
    return { passed: true, output: '' };
  } catch (err) {
    return { passed: false, output: String(err.stdout || '') + String(err.stderr || '') };
  }
}

function restore() {
  fs.writeFileSync(TARGET, ORIGINAL);
}

process.on('exit', restore);
process.on('SIGINT', () => {
  restore();
  process.exit(1);
});

// Canary: a module that throws on import must fail every spec that reaches it.
fs.writeFileSync(TARGET, `throw new Error('MUTATION CANARY');\n${ORIGINAL}`);
const canary = runSpecs();
restore();
if (canary.passed) {
  console.log('[sweep] CANARY SURVIVED — the spec selection does not exercise this module. Not reporting.');
  process.exit(1);
}
console.log('[sweep] canary killed, selection is sound\n');

const survivors = [];
const invalid = [];
let killed = 0;
const chosen = mutations.slice(0, LIMIT);

for (const [n, m] of chosen.entries()) {
  fs.writeFileSync(TARGET, m.apply());
  const result = runSpecs();
  restore();

  // A module that will not parse fails every spec, which looks exactly like a
  // kill. Its signature is that nothing ran at all. Matching on error text
  // alone was wrong: one app log line reads "Failed to parse URL from ..." and
  // that alone marked every mutation invalid.
  const broken = /Transform failed/.test(result.output) || /Tests {2}no tests/.test(result.output);
  if (broken && process.env.MUTATE_DEBUG) {
    console.log('  [debug] invalid:', result.output.slice(0, 800));
  }
  if (!result.passed && broken) {
    invalid.push(m);
    console.log(`  [${n + 1}/${chosen.length}] L${m.line} INVALID  ${m.preview}`);
  } else if (result.passed) {
    survivors.push(m);
    console.log(`  [${n + 1}/${chosen.length}] L${m.line} SURVIVED ${m.preview}`);
  } else {
    killed += 1;
    console.log(`  [${n + 1}/${chosen.length}] L${m.line} killed`);
  }
}

console.log(`\n[sweep] ${target}: ${killed}/${killed + survivors.length} killed, ${invalid.length} invalid`);
if (survivors.length) {
  console.log('[sweep] survivors — each must be read, not assumed equivalent:');
  for (const s of survivors) console.log(`  L${s.line}  ${s.preview}`);
}
