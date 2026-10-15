import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CAMPAIGN_PROOF = 'services/application-service/selfcheck/verify-campaign-control-plane.ts';

// Only the runner is under test here. Fake proof commands never touch live
// infrastructure; their success/failure is used to test tee/pipefail/evidence.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'usrp-runner-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts/test'), { recursive: true });
  for (const script of ['run-selfchecks.sh', 'check-env-file.mjs']) {
    copyFileSync(join(ROOT, 'scripts', script), join(root, 'scripts', script));
  }
  writeFileSync(join(root, 'scripts/check-workspace-build.mjs'), '// runner fixture\n');
  writeFileSync(join(root, 'scripts/test/fixture.test.mjs'), "import test from 'node:test'; test('runner fixture', () => {});\n");
  writeFileSync(join(root, 'scripts/verify-dev-boot.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(root, '.env.example'), 'NODE_ENV=development\n');
  mkdirSync(join(root, 'packages/shared-database/src/rls'), { recursive: true });
  writeFileSync(join(root, 'packages/shared-database/src/rls/verify-isolation.sql'), '-- runner fixture\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash
printf 'stdout for %s\\n' "$2"
printf 'stderr for %s\\n' "$2" >&2
if [[ "$2" == "\${FAILED_PROOF:-}" ]]; then
  printf 'CONTROL_ASSERTION_FAILURE\\n' >&2
  exit 23
fi
exit 0
`, { mode: 0o700 });
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  return root;
}

function run(root, failedProof) {
  const logs = join(root, 'retained-logs');
  const result = spawnSync('bash', ['scripts/run-selfchecks.sh'], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
    env: {
      ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      USRP_ENV_FILE: '.env.example', USRP_SELFCHECK_LOG_DIR: logs,
      FAILED_PROOF: failedProof, FIRST_ADMIN_DATABASE_URL: '',
    },
  });
  assert.equal(result.error, undefined);
  return { result, logs };
}

test('tee cannot hide a failed proof; its stdout/stderr and log path survive the final summary', (t) => {
  const root = fixture(t);
  const { result, logs } = run(root, CAMPAIGN_PROOF);
  assert.equal(result.status, 1);
  const text = result.stdout + result.stderr;
  const log = join(logs, CAMPAIGN_PROOF.replace(/\.ts$/u, '.log'));
  assert.equal(existsSync(log), true);
  const evidence = readFileSync(log, 'utf8');
  assert.ok(evidence.includes(`stdout for ${CAMPAIGN_PROOF}`));
  assert.ok(evidence.includes(`stderr for ${CAMPAIGN_PROOF}`));
  assert.ok(evidence.includes('CONTROL_ASSERTION_FAILURE'));
  const summary = text.slice(text.lastIndexOf('Failed proofs:'));
  assert.ok(summary.includes('campaign control-plane P5–P17'));
  assert.ok(summary.includes(`log: ${log.slice(root.length + 1)}`));
  // Failures are collected, not masked or fail-fast: later proofs still run.
  assert.ok(existsSync(join(logs, 'services/application-service/selfcheck/verify-pipeline-e2e.log')));
});

test('a passing run stays green, reports its skip honestly, and retains service-relative proof logs', (t) => {
  const root = fixture(t);
  const { result, logs } = run(root, '');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // run() blanks FIRST_ADMIN_DATABASE_URL, so the direct provisioner proof is
  // SKIPPED: a passing run with a skip must say so and never claim ALL GREEN.
  assert.match(result.stdout, /PROOFS PASSED WITH 1 SKIPPED CHECK\(S\)/u);
  assert.doesNotMatch(result.stdout, /ALL PROOFS GREEN/u);
  const identity = join(logs, 'services/identity-service/selfcheck/verify-slice.log');
  const biometric = join(logs, 'services/biometric-service/selfcheck/verify-biometric-slice.log');
  assert.ok(readFileSync(identity, 'utf8').includes('services/identity-service/'));
  assert.ok(readFileSync(biometric, 'utf8').includes('services/biometric-service/'));
});
