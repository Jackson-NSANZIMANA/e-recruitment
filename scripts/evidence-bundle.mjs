#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// evidence-bundle.mjs — write evidence-<sha>.json for one CI run (W0-04, S00)
//
// WHY THIS EXISTS
//
// The capability map was stale within a day of being written, and the frontend
// docs still quoted 27 edge operations when the registry held 43. Hand-written
// counts and SHAs rot; a bundle CI writes for every commit does not. Docs point
// here instead of restating numbers.
//
// WHAT IT RECORDS
//
//   • the commit tested, and the peer SHA it pins (the backend pins none);
//   • the edge operation inventory, read from the built registry itself;
//   • proof counts from the selfcheck runner's own summary line, with skipped
//     and failed checks named separately;
//   • unit-test counts from each package's JUnit report, with every skipped
//     test listed by name. `pnpm verify` does not run these suites, so this
//     job runs them;
//   • the lockfile hash, and the result of every other CI job.
//
// DESIGN NOTES
//
//   • Zero dependencies; Node built-ins only.
//   • "Could not measure" is recorded as `not-available`, never as zero.
//   • Exits non-zero when a unit test fails or the inventory cannot be read,
//     after writing the bundle, so the job can never be green over a red suite.
//
//   usage: node scripts/evidence-bundle.mjs --out <dir> [--proofs-log <file>]
//          [--run-tests] [--needs '<toJSON(needs)>']
// ═══════════════════════════════════════════════════════════════════════════

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Jackson-NSANZIMANA/e-recruitment';
const PEER = 'Jackson-NSANZIMANA/e-recruitment-ui';
const JUNIT_DIR = 'test-results';
const JUNIT_FILE = 'unit.junit.xml';

const stripAnsi = stripVTControlCharacters;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(Number(e[1].toLowerCase() === 'x' ? `0${e.slice(1)}` : e.slice(1))) : ENTITIES[e.toLowerCase()]);

function attributes(text) {
  const out = {};
  for (const [, key, dq, sq] of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[key] = decodeXml(dq ?? sq);
  return out;
}

// One element tag. Attribute values are matched as quoted strings, so a raw
// `>` inside one (node:test writes failure messages unescaped there) does not
// end the tag early.
const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

/** Parse the selfcheck runner's output. The summary line is authoritative. */
export function parseProofLog(raw) {
  const text = stripAnsi(raw);
  const summary = text.match(/^Proofs: (\d+) passed(?:, (\d+) skipped)?, (\d+) failed$/m);
  if (summary === null) {
    return { status: 'not-available', reason: 'no runner summary line in the log (the run did not finish)' };
  }
  const [passed, skipped, failed] = [summary[1], summary[2] ?? '0', summary[3]].map(Number);
  const labels = (pattern) => [...text.matchAll(pattern)].map((m) => m[1].trim());
  return {
    status: failed > 0 ? 'failed' : skipped > 0 ? 'passed-with-skips' : 'passed',
    passed,
    skipped,
    failed,
    skippedChecks: labels(/^↷ SKIP — (.+)$/gm),
    failedChecks: labels(/^✗ FAIL — (.+)$/gm),
  };
}

/** Parse a JUnit report (node:test or vitest) into leaf test cases. */
export function parseJUnit(xml, root = ROOT) {
  const cases = [];
  const body = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, '');
  let open = null;
  const close = () => {
    const file = open.attrs.file ?? open.attrs.classname ?? '';
    cases.push({
      name: open.attrs.name ?? '',
      file: file.startsWith('/') ? relative(root, file) : file,
      outcome: open.failure ? 'failed' : open.skipped ? 'skipped' : 'passed',
      ...(open.failure ? { reason: open.failure.slice(0, 500) } : open.skipped ? { reason: open.skipped.reason } : {}),
    });
    open = null;
  };
  for (const [, slash, name, attrText, selfClosing] of body.matchAll(TAG)) {
    if (name === 'testcase') {
      if (slash) { if (open) close(); continue; }
      open = { attrs: attributes(attrText), failure: null, skipped: null };
      if (selfClosing) close();
    } else if (open && !slash && (name === 'failure' || name === 'error')) {
      const attrs = attributes(attrText);
      open.failure ??= attrs.message || attrs.type || `<${name}> without a message`;
    } else if (open && !slash && name === 'skipped') {
      const attrs = attributes(attrText);
      open.skipped ??= { reason: attrs.message ?? attrs.type ?? '' };
    }
  }
  return cases;
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function workspacePackages() {
  const listed = JSON.parse(execFileSync('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], { cwd: ROOT, encoding: 'utf8' }));
  return listed
    .filter((p) => p.path !== ROOT)
    .map((p) => ({ name: p.name, dir: p.path, scripts: JSON.parse(readFileSync(join(p.path, 'package.json'), 'utf8')).scripts ?? {} }))
    .filter((p) => typeof p.scripts.test === 'string')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Run every package's `test` script with a JUnit reporter beside its own output. */
function runTests() {
  const packages = [];
  for (const pkg of workspacePackages()) {
    const outDir = join(pkg.dir, JUNIT_DIR);
    const report = join(outDir, JUNIT_FILE);
    rmSync(report, { force: true });
    mkdirSync(outDir, { recursive: true });
    console.log(`\n── ${pkg.name}: ${pkg.scripts.test}`);
    const started = Date.now();
    const result = spawnSync('pnpm', ['run', 'test'], {
      cwd: pkg.dir,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS ?? '', '--test-reporter=spec', '--test-reporter-destination=stdout',
          '--test-reporter=junit', `--test-reporter-destination=${JUNIT_DIR}/${JUNIT_FILE}`].join(' ').trim(),
      },
    });
    const cases = existsSync(report) ? parseJUnit(readFileSync(report, 'utf8')) : null;
    const count = (outcome) => (cases === null ? null : cases.filter((c) => c.outcome === outcome).length);
    packages.push({
      name: pkg.name,
      exitCode: result.status,
      durationMs: Date.now() - started,
      tests: cases === null ? null : cases.length,
      passed: count('passed'),
      failed: count('failed'),
      skipped: count('skipped'),
      cases,
    });
  }
  return packages;
}

function summariseTests(packages) {
  if (packages === null) return { status: 'not-available', reason: 'tests were not run (--run-tests not passed)' };
  const all = packages.flatMap((p) => (p.cases ?? []).map((c) => ({ package: p.name, ...c })));
  const sum = (key) => packages.reduce((n, p) => n + (p[key] ?? 0), 0);
  const failedPackages = packages.filter((p) => p.exitCode !== 0).map((p) => p.name);
  // A package that exits 0 without a report ran tests nobody counted; its
  // tests are recorded as null and the totals say so, never as zero.
  const unreportedPackages = packages.filter((p) => p.cases === null).map((p) => p.name);
  return {
    status: failedPackages.length > 0 ? 'failed' : unreportedPackages.length > 0 ? 'passed-with-unreported' : 'passed',
    source: `each workspace package's \`test\` script, JUnit via node --test-reporter (${JUNIT_DIR}/${JUNIT_FILE})`,
    totals: { packages: packages.length, reportedPackages: packages.length - unreportedPackages.length, tests: sum('tests'), passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped') },
    failedPackages,
    unreportedPackages,
    skippedTests: all.filter((c) => c.outcome === 'skipped').map(({ outcome, ...c }) => c),
    failedTests: all.filter((c) => c.outcome === 'failed').map(({ outcome, ...c }) => c),
    packages: packages.map(({ cases, ...p }) => p),
  };
}

async function operationInventory() {
  const registry = join(ROOT, 'services/edge-gateway/dist/domain/edge-operations.js');
  if (!existsSync(registry)) return { status: 'not-available', reason: 'edge-gateway is not built (run pnpm build first)' };
  // The edge's own projection (ADR-038): GET /version reports the same hash,
  // so a running edge and this bundle compare by one value. The inline
  // projection below is the fallback for a build that predates it.
  const fingerprints = join(ROOT, 'services/edge-gateway/dist/domain/version-fingerprints.js');
  if (existsSync(fingerprints)) {
    const items = (await import(pathToFileURL(fingerprints).href)).operationInventory();
    return { status: 'available', source: 'services/edge-gateway/src/domain/version-fingerprints.ts (built)', count: items.length, sha256: sha256(JSON.stringify(items)), items };
  }
  const { EDGE_OPERATIONS } = await import(pathToFileURL(registry).href);
  const items = Object.values(EDGE_OPERATIONS)
    .map((op) => ({
      id: op.operationId,
      method: op.method,
      path: op.path,
      session: op.session,
      permission: op.permission ?? null,
      csrf: op.csrf,
      publicAllowlist: op.publicAllowlist,
      idempotentWithoutSession: op.idempotentWithoutSession ?? false,
      maxBodyBytes: op.maxBodyBytes,
      retryOnG2G: op.retryOnG2G,
      composition: op.composition,
      upstream: op.upstream.map((u) => u.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    status: 'available',
    source: 'services/edge-gateway/src/domain/edge-operations.ts (built)',
    count: items.length,
    sha256: sha256(JSON.stringify(items)),
    items,
  };
}

function parseArgs(argv) {
  const args = { out: null, proofsLog: null, runTests: false, needs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[++i];
    else if (arg === '--proofs-log') args.proofsLog = argv[++i];
    else if (arg === '--needs') args.needs = argv[++i];
    else if (arg === '--run-tests') args.runTests = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.out) throw new Error('--out <dir> is required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const head = env.EVIDENCE_HEAD_SHA || git('rev-parse', 'HEAD');

  const proofs = args.proofsLog === null
    ? { status: 'not-available', reason: 'no proofs log supplied' }
    : existsSync(args.proofsLog)
      ? { source: 'scripts/run-selfchecks.sh summary (pnpm verify)', ...parseProofLog(readFileSync(args.proofsLog, 'utf8')) }
      : { status: 'not-available', reason: `proofs log not found: ${args.proofsLog}` };
  const operations = await operationInventory();
  const tests = summariseTests(args.runTests ? runTests() : null);

  const bundle = {
    schema: 'usrp-evidence/v1',
    repo: REPO,
    commit: {
      sha: head,
      testedSha: env.GITHUB_SHA || head,
      ref: env.GITHUB_REF || git('rev-parse', '--abbrev-ref', 'HEAD'),
      event: env.GITHUB_EVENT_NAME || 'local',
      run: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    },
    peer: { repo: PEER, pinnedSha: null, note: 'the backend pins no frontend; the frontend pins this repository (BACKEND_SHA)' },
    lockfile: { path: 'pnpm-lock.yaml', sha256: sha256(readFileSync(join(ROOT, 'pnpm-lock.yaml'))) },
    operations,
    proofs,
    tests,
    jobs: args.needs === null ? null : Object.fromEntries(Object.entries(JSON.parse(args.needs)).map(([k, v]) => [k, v.result])),
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, `evidence-${head}.json`);
  writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);

  console.log(`\nevidence: ${relative(process.cwd(), file)}`);
  console.log(`  operations: ${operations.count ?? operations.status}`);
  console.log(`  proofs:     ${proofs.status}${proofs.passed === undefined ? '' : ` (${proofs.passed} passed, ${proofs.skipped} skipped, ${proofs.failed} failed)`}`);
  for (const label of proofs.skippedChecks ?? []) console.log(`    skipped: ${label}`);
  console.log(`  tests:      ${tests.status}${tests.totals ? ` (${tests.totals.tests} in ${tests.totals.reportedPackages} reporting packages: ${tests.totals.passed} passed, ${tests.totals.skipped} skipped, ${tests.totals.failed} failed)` : ''}`);
  for (const name of tests.unreportedPackages ?? []) console.log(`    unreported: ${name} (exited ${tests.packages.find((p) => p.name === name)?.exitCode}, no JUnit report)`);
  for (const t of tests.skippedTests ?? []) console.log(`    skipped: ${t.package} › ${t.name}`);

  if (operations.status !== 'available') process.exitCode = 1;
  if (tests.status === 'failed') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`evidence-bundle: ${error.message}`);
    process.exit(1);
  });
}
