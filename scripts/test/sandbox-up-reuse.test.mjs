// Proof for infrastructure/sandbox/up.sh's reuse rule: a sandbox already answering on :4921 is reused only
// when its boot record matches what this boot asks for. SMS mode and the private persona are fixed when the
// services start, so a sandbox booted on the emulator must not be reused by a `--real-sms` boot (it would
// keep texting the emulator inbox while saying it is up), nor one booted without the persona by a boot that
// names one.
//
// The real up.sh runs in a throwaway repository with curl (every unit answers 200), docker (the broker runs)
// and pnpm stubbed on PATH, so no sandbox, Docker or network is needed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(t, record) {
  const root = mkdtempSync(join(tmpdir(), 'usrp-sandbox-up-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  for (const d of [join(repo, 'infrastructure/sandbox'), join(repo, 'node_modules'), join(repo, 'packages/shared-types/dist'), join(repo, '.sandbox'), bin]) {
    mkdirSync(d, { recursive: true });
  }
  copyFileSync(join(ROOT, 'infrastructure/sandbox/up.sh'), join(repo, 'infrastructure/sandbox/up.sh'));
  writeFileSync(join(repo, 'packages/shared-types/dist/index.js'), '');
  if (record !== undefined) writeFileSync(join(repo, '.sandbox/running.json'), JSON.stringify(record));
  const stubs = {
    curl: '#!/usr/bin/env bash\nprintf 200\n',
    docker: '#!/usr/bin/env bash\necho true\n',
    pnpm: '#!/usr/bin/env bash\necho "pnpm $*"; echo "REHEARSAL STAGED"\n',
  };
  for (const [name, body] of Object.entries(stubs)) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { repo, bin };
}

function up(fx, env = {}) {
  const r = spawnSync('bash', [join(fx.repo, 'infrastructure/sandbox/up.sh')], {
    cwd: fx.repo,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, SANDBOX_DB: 'usrp_sandbox', SANDBOX_FORENSICS: '1', SANDBOX_SMS: '', SANDBOX_PRIVATE_PERSONA_DIR: '', SANDBOX_STAGE: '0', ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

const BASE = { db: 'usrp_sandbox', forensics: true, simulator: 4900, ports: [4901, 4921] };

test('an emulator sandbox is reused by an emulator boot', (t) => {
  const r = up(fixture(t, { ...BASE, sms: 'emulator', persona: false }));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already running — reusing it/);
});

test('a record from before sms/persona were kept reads as an emulator boot without a persona', (t) => {
  const fx = fixture(t, BASE);
  assert.equal(up(fx).status, 0);
  const r = up(fx, { SANDBOX_SMS: 'twilio' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /through the emulator, and this boot asks for real Twilio/);
});

test('a --real-sms boot refuses an emulator sandbox instead of reusing it', (t) => {
  const r = up(fixture(t, { ...BASE, sms: 'emulator', persona: false }), { SANDBOX_SMS: 'twilio' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /sends SMS through the emulator, and this boot asks for real Twilio.*sandbox:full --down/s);
  assert.doesNotMatch(r.out, /reusing it/);
});

test('an emulator boot refuses a sandbox that sends real SMS', (t) => {
  const r = up(fixture(t, { ...BASE, sms: 'twilio', persona: false }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /through the twilio, and this boot asks for the emulator|sends SMS through the twilio/);
});

test('a boot naming a private persona refuses a sandbox started without one, and the reverse', (t) => {
  let r = up(fixture(t, { ...BASE, sms: 'twilio', persona: false }), { SANDBOX_SMS: 'twilio', SANDBOX_PRIVATE_PERSONA_DIR: '/somewhere' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /started without the private persona this boot asks for/);
  r = up(fixture(t, { ...BASE, sms: 'twilio', persona: true }), { SANDBOX_SMS: 'twilio' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /started with a private persona, and this boot has none/);
  r = up(fixture(t, { ...BASE, sms: 'twilio', persona: true }), { SANDBOX_SMS: 'twilio', SANDBOX_PRIVATE_PERSONA_DIR: '/somewhere' });
  assert.equal(r.status, 0, r.out);
});
