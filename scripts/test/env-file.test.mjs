import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findEnvErrors } from '../check-env-file.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = ['check-env-file.mjs', 'dev.sh', 'verify-dev-boot.sh', 'generate-env.sh', 'run-selfchecks.sh'];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'usrp-env-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  for (const file of SCRIPTS) copyFileSync(join(ROOT, 'scripts', file), join(root, 'scripts', file));
  return root;
}

function run(root, script, args = [], env = {}) {
  return spawnSync('bash', [join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, USRP_ENV_FILE: '.env.example', ...env },
  });
}

function output(result) {
  assert.equal(result.error, undefined);
  return result.stdout + result.stderr;
}

test('the committed template contains only literal assignments and comments', () => {
  assert.deepEqual(findEnvErrors(readFileSync(join(ROOT, '.env.example'), 'utf8')), []);
});

test('accepts blank lines, export, empty values, URLs, hashes, quotes, escapes and comments', () => {
  const valid = [
    '', '  # comment', '\t', 'EMPTY=', 'export PORT=4001 # comment',
    'URL=postgresql://usrp_app:app_pw@localhost:5432/usrp_db',
    'HASH=abc#123', 'LIST=image/jpeg,image/png,application/pdf',
    "SECRET='spaces $literal `literal` ; & | ( ) < > ~ # unicode: é'",
    'DOUBLE="spaces and # punctuation ; & | < >"',
    'ESCAPED=a\\ b\\;c\\$d\\`e', 'QUOTED="literal \\$value and \\`text\\`"',
    "APOSTROPHE='can'\\''t'", "CONCAT='hello'\"world\"", 'TRAILING=ok\t # comment',
  ].join('\n');
  assert.deepEqual(findEnvErrors(valid), []);
});

test('reports pasted prose at the incident line, even though bash -n accepts it', () => {
  const content = '\n'.repeat(373) + 'THERE ARE PROBLEMS I ENCOUNTERED\n';
  const syntax = spawnSync('bash', ['-n'], { input: content, encoding: 'utf8' });
  assert.equal(syntax.status, 0);
  const errors = findEnvErrors(content);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 374);
  assert.match(errors[0].reason, /KEY=value.*prose/u);
});

test('rejects commands, expansions, operators and unquoted trailing prose', () => {
  for (const line of [
    'THERE ARE PROBLEMS', 'KEY =value', '1KEY=value', 'KEY=value other text',
    'KEY=value OTHER=value', "KEY='value';echo unsafe", 'KEY=value && echo unsafe',
    'KEY=value | cat', 'KEY=value > file', 'KEY=value < file',
    'KEY=$(echo unsafe)', 'KEY=`echo unsafe`', 'KEY=${OTHER}', 'KEY=$((1+2))',
    'KEY="$(echo unsafe)"', 'KEY=~/.config', 'export KEY',
  ]) {
    assert.equal(findEnvErrors(line).length, 1, line);
  }
});

test('rejects unterminated quotes, continuations, multiline values and control bytes', () => {
  for (const line of ["KEY='missing", 'KEY="missing', 'KEY=value\\', 'KEY=bad\0value', 'KEY=bad\rvalue']) {
    assert.equal(findEnvErrors(line).length, 1);
  }
  assert.notEqual(findEnvErrors("KEY='multi\nline'\n").length, 0);
});

test('accepts CRLF with the same normalization used by dev.sh', () => {
  assert.deepEqual(findEnvErrors("# comment\r\nPORT=4001\r\nSECRET='literal'\r\n"), []);
});

test('CLI reports file and line without echoing secret-bearing input', (t) => {
  const root = fixture(t);
  const file = join(root, '.env.example');
  writeFileSync(file, "SECRET='never-display-this-value'; echo unsafe\n");
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-env-file.mjs'), file], {
    cwd: root, encoding: 'utf8',
  });
  const text = output(result);
  assert.equal(result.status, 1);
  assert.ok(text.includes(`${file}:1:`));
  assert.ok(!text.includes('never-display-this-value'));
});

test('CLI fails closed on an unreadable file and on invalid arguments', (t) => {
  const root = fixture(t);
  const cli = join(root, 'scripts/check-env-file.mjs');
  const missing = spawnSync(process.execPath, [cli, join(root, 'missing.env')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(output(missing), /cannot read environment file/u);
  const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});

for (const script of ['dev.sh', 'verify-dev-boot.sh', 'run-selfchecks.sh']) {
  test(`${script} rejects a corrupt file before build checks, Turbo, probes or command execution`, (t) => {
    const root = fixture(t);
    const marker = join(root, 'must-not-execute');
    writeFileSync(join(root, '.env.example'), `GOOD=ok\nTHERE ARE PROBLEMS\nDANGER=$(touch '${marker}')\n`);
    mkdirSync(join(root, '.boot-logs'));
    const oldLog = join(root, '.boot-logs/dev-boot.log');
    writeFileSync(oldLog, 'previous boot evidence\n');
    const result = run(root, script, [], { BOOT_TIMEOUT_S: '1' });
    const text = output(result);
    assert.equal(result.status, 1);
    assert.match(text, /\.env\.example:2:/u);
    assert.ok(!text.includes('never answered'));
    assert.doesNotMatch(text, /booting \d+ services/u);
    assert.ok(!text.includes('command not found'));
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(oldLog, 'utf8'), 'previous boot evidence\n');
    assert.equal(existsSync(join(root, '.selfcheck-logs')), false);
  });
}

test('generate-env --force preserves the existing .env when the template is corrupt', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, '.env.example'), 'KEY=ok\nTHERE ARE PROBLEMS\n');
  writeFileSync(join(root, '.env'), 'EXISTING=keep-me\n');
  const result = run(root, 'generate-env.sh', ['--force', '--keep-keys']);
  assert.equal(result.status, 1);
  assert.match(output(result), /\.env\.example:2:/u);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'EXISTING=keep-me\n');
});

test('generate-env --keep-keys renders a valid template unchanged', (t) => {
  const root = fixture(t);
  const content = "KEY='literal $value with spaces'\n";
  writeFileSync(join(root, '.env.example'), content);
  const result = run(root, 'generate-env.sh', ['--keep-keys']);
  assert.equal(result.status, 0, output(result));
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), content);
});

test('dev.sh loads literal CRLF values from an absolute path and schedules every persistent task', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'services/identity-service/src'), { recursive: true });
  writeFileSync(join(root, 'services/identity-service/src/main.ts'), '// fixture\n');
  writeFileSync(join(root, 'scripts/check-workspace-build.mjs'), '// fixture: no real build or service launch\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), '#!/usr/bin/env bash\nprintf "%s\\n" "$PORT_IDENTITY_SERVICE" "$TEST_VALUE" "$@" > "$TEST_LAUNCH_MARKER"\n', { mode: 0o700 });
  const file = join(root, '.env.absolute.example');
  writeFileSync(file, "PORT_IDENTITY_SERVICE=44001\r\nTEST_VALUE='literal $NOT_EXPANDED; command text'\r\n");
  const marker = join(root, 'launch');
  const result = run(root, 'dev.sh', ['--ui=stream'], {
    USRP_ENV_FILE: file, PATH: `${bin}:${process.env.PATH}`, TEST_LAUNCH_MARKER: marker,
  });
  assert.equal(result.status, 0, output(result));
  assert.equal(readFileSync(marker, 'utf8'), [
    '44001', 'literal $NOT_EXPANDED; command text', 'exec', 'turbo', 'run', 'dev',
    '--concurrency=2', '--ui=stream', '',
  ].join('\n'));
});
