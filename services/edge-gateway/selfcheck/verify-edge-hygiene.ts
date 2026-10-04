// ══════════════════════════════════════════════════════════════════
// edge-gateway — ARCHITECTURE HYGIENE PROOF (zero infrastructure)
//
// The homogenisation removed a split brain (two registries, two audit sinks,
// two session stacks). This proof is what stops it growing back. It reads the
// source tree and fails on:
//
//   1. any surviving legacy folder (registry/ session/ security/ upstream/
//      observability/) or the stray nested services/edge-gateway/ copy;
//   2. any import of those folders;
//   3. a driven adapter (src/adapters/*.ts) importing the HTTP adapter layer;
//   4. domain/ or crypto/ importing adapters/, application/ or ports/;
//   5. a raw console.* outside main.ts and the audit adapter (every other line
//      must go through the redacting sink);
//   6. the redacting sink itself leaking an NID-shaped value or an error
//      message through the fault channel.
// ══════════════════════════════════════════════════════════════════

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdoutAuditLogger } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m  \u2713 ${label}\u001b[0m`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`\u001b[0;31m  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`);
  }
}
function section(title: string): void {
  console.log(`\n\u001b[1;36m══ ${title}\u001b[0m`);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const LEGACY = ['registry', 'session', 'security', 'upstream', 'observability'];

section('Legacy trees are gone');
for (const folder of LEGACY) {
  check(`src/${folder}/ does not exist`, !existsSync(join(SRC, folder)));
}
check('no nested services/edge-gateway/ copy', !existsSync(join(ROOT, 'services')));
check('fixed-window-rate-limiter.ts is gone', !existsSync(join(SRC, 'adapters', 'fixed-window-rate-limiter.ts')));

const files = walk(SRC);
const IMPORT_RE = /^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm;

section('Import direction');
for (const file of files) {
  const rel = relative(SRC, file).split(sep).join('/');
  const text = readFileSync(file, 'utf8');
  const specs = [...text.matchAll(IMPORT_RE)].map((m) => m[1] ?? '');
  const legacy = specs.filter((s) => LEGACY.some((folder) => new RegExp(`(^|/)${folder}/`).test(s) && s.startsWith('.')));
  check(`${rel}: imports no legacy folder`, legacy.length === 0, legacy.join(', '));

  if (/^adapters\/[^/]+\.ts$/.test(rel)) {
    const http = specs.filter((s) => s.startsWith('./http/'));
    check(`${rel}: driven adapter does not import adapters/http`, http.length === 0, http.join(', '));
  }
  if (rel.startsWith('domain/') || rel.startsWith('crypto/')) {
    const inward = specs.filter((s) => /(^|\/)(adapters|application|ports)\//.test(s));
    check(`${rel}: imports nothing outward`, inward.length === 0, inward.join(', '));
  }

  const allowConsole = rel === 'main.ts' || rel === 'adapters/audit-logger.adapter.ts';
  if (!allowConsole) {
    // Strip comments so a comment that MENTIONS console.error is not a failure.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    check(`${rel}: no raw console.*`, !/\bconsole\.(log|error|warn|info|debug)\s*\(/.test(code));
  }
}

section('The redacting sink redacts every channel');
const lines: string[] = [];
const sink = (line: string): void => {
  lines.push(line);
};
const audit = new StdoutAuditLogger(sink, () => new Date('2026-10-02T00:00:00Z'), sink);
const nid = '1199880012345678';
audit.log({ action: 'EDGE_SESSION_REJECTED', correlationId: 'c1', detail: { nationalId: nid, note: `x${nid}x` } });
const pgLike = Object.assign(new Error(`duplicate key value (national_id)=(${nid})`), { name: 'PostgresError', code: '23505' });
audit.fault({ event: 'EDGE_SESSION_SWEEP_FAILED', detail: { handle: 'secret-handle' } }, pgLike);
audit.stats({ sessionsSwept: 3 });
const joined = lines.join('\n');
check('no NID-shaped run in any line', !joined.includes(nid), joined);
check('fault line keeps the error name and code', joined.includes('PostgresError') && joined.includes('23505'));
check('fault line drops the error message', !joined.includes('duplicate key value'));
check('forbidden keys are redacted in faults', !joined.includes('secret-handle'));
check('three lines written', lines.length === 3, String(lines.length));

console.log(`\n\u001b[1m────────────────────────────────────────\u001b[0m`);
if (fail === 0) {
  console.log(`\u001b[1;32mEDGE HYGIENE GREEN — ${String(pass)} checks ✓\u001b[0m`);
  process.exit(0);
}
console.error(`\u001b[0;31m${String(fail)} of ${String(pass + fail)} checks failed\u001b[0m`);
for (const label of failures) console.error(`  \u001b[0;31m✗ ${label}\u001b[0m`);
process.exit(1);
