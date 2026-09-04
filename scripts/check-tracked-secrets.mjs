#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// check-tracked-secrets.mjs — refuse to ship a tracked secret file
//
// WHY THIS EXISTS
//
// On 2026-08-27, `.env.backup.20260827074511` (10,052 bytes of live
// configuration) was committed to main. The .gitignore at the time carried the
// comment "Environment files (NEVER commit these)" and a list of five exact
// filenames. `.env.backup.<timestamp>` matched none of them.
//
// The ignore rule is now deny-by-default. This file is the enforcement, because
// .gitignore is advisory: `git add -f` ignores it entirely, and a rule nothing
// verifies is a rule that has already stopped working somewhere you cannot see.
//
// DESIGN NOTES, each one load-bearing:
//
//   • Reads the git INDEX (`git ls-files`), not the filesystem. A developer's
//     own untracked .env is none of this gate's business, and a gate that fails
//     on a legitimate local file gets commented out.
//   • ZERO dependencies. Runs before `pnpm install`, so a registry outage or a
//     lockfile conflict cannot silently skip the most important check in CI.
//   • Fails CLOSED. If `git` cannot be reached at all, it exits non-zero rather
//     than passing with a warning. "Could not verify" is not "verified".
//   • --selftest proves it RED then GREEN. A gate nobody has watched fail is
//     indistinguishable from `exit 0`.
// ═══════════════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A tracked path is a violation unless it is an explicitly allowed template.
 * Order matters: ALLOW is consulted first, so a template can never be flagged.
 */
const ALLOW = [
  /(^|\/)\.env\.example$/,
  /(^|\/)\.env\.[^/]+\.example$/,
  /\.tfvars\.example$/,
  /(^|\/)\.gitkeep$/,
];

const DENY = [
  // Any .env variant that is not an allowed template.
  { pattern: /(^|\/)\.env($|\.)/, why: 'environment file (may contain live credentials)' },
  { pattern: /\.env$/, why: 'environment file (may contain live credentials)' },
  // Private keys and certificate material.
  { pattern: /\.(pem|key|p12|pfx|jks|keystore|pkcs12)$/, why: 'private key / certificate material' },
  // Backup and editor copies, which are how secrets travel under a new name.
  { pattern: /\.(backup|bak|orig|save)$/, why: 'backup copy (secrets travel under new suffixes)' },
  { pattern: /~$/, why: 'editor backup copy' },
  // Terraform state carries resolved secret values in plaintext.
  { pattern: /terraform\.tfstate(\.backup)?$/, why: 'terraform state (contains resolved secrets)' },
  { pattern: /\.tfvars$/, why: 'terraform variables (commonly secret-bearing)' },
];

function trackedFiles(cwd) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\0').filter((line) => line.length > 0);
}

export function findViolations(paths) {
  const violations = [];
  for (const path of paths) {
    if (ALLOW.some((allowed) => allowed.test(path))) continue;
    for (const { pattern, why } of DENY) {
      if (pattern.test(path)) {
        violations.push({ path, why });
        break;
      }
    }
  }
  return violations;
}

function report(violations) {
  if (violations.length === 0) {
    console.log('check-tracked-secrets: OK — no secret-bearing file is tracked.');
    return 0;
  }
  console.error(`\ncheck-tracked-secrets: ${violations.length} tracked file(s) must not be in git:\n`);
  for (const { path, why } of violations) console.error(`  ✗ ${path}\n      ${why}`);
  console.error(`
  Untracking is NOT sufficient on its own. If any of these ever held a real
  value, that value is in git history and must be treated as disclosed:

    1. ROTATE the credential first. See docs/security/SECRET-ROTATION.md.
    2. git rm --cached <path>
    3. Confirm .gitignore denies the pattern (it is deny-by-default).
    4. Plan a history rewrite for the blob — coordinate, it is a force-push.
`);
  return 1;
}

// ── Selftest ──────────────────────────────────────────────────────────────────
// Builds a disposable repo and proves each verdict. Never touches the real tree.

function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'tracked-secrets-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  let failures = 0;
  const assert = (label, actual, expected) => {
    const ok = actual === expected;
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures += 1;
  };

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@localhost');
    git('config', 'user.name', 'selftest');

    // GREEN baseline: the documented template must never be flagged.
    writeFileSync(join(dir, '.env.example'), 'DATABASE_URL=\n');
    git('add', '-A');
    assert('.env.example alone is GREEN', findViolations(trackedFiles(dir)).length, 0);

    // RED: the exact filename from the incident this gate exists for.
    writeFileSync(join(dir, '.env.backup.20260827074511'), 'DATABASE_URL=postgres://real\n');
    git('add', '-f', '.env.backup.20260827074511');
    const incident = findViolations(trackedFiles(dir));
    assert('.env.backup.<timestamp> is RED', incident.length, 1);
    assert('  and the violation names the file', incident[0]?.path, '.env.backup.20260827074511');

    // GREEN again once removed — proves the gate is not simply always-red.
    git('rm', '-q', '--cached', '.env.backup.20260827074511');
    assert('GREEN again once untracked', findViolations(trackedFiles(dir)).length, 0);

    // RED: private key material.
    writeFileSync(join(dir, 'signing.pem'), '-----BEGIN PRIVATE KEY-----\n');
    git('add', '-f', 'signing.pem');
    assert('a tracked .pem is RED', findViolations(trackedFiles(dir)).length, 1);
    git('rm', '-q', '--cached', 'signing.pem');

    // RED: a plain `.env`, the case the old rule DID cover — still covered.
    writeFileSync(join(dir, '.env'), 'SECRET=1\n');
    git('add', '-f', '.env');
    assert('a tracked .env is RED', findViolations(trackedFiles(dir)).length, 1);

    console.log(failures === 0 ? '\nselftest: all assertions passed.' : `\nselftest: ${failures} FAILED.`);
    return failures === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const isSelftest = process.argv.includes('--selftest');
try {
  process.exit(isSelftest ? selftest() : report(findViolations(trackedFiles(process.cwd()))));
} catch (error) {
  // Fail closed. "We could not check" must never read as "there is nothing here".
  console.error(`check-tracked-secrets: could not inspect the git index — ${error.message}`);
  console.error('Failing closed: an unverifiable index is treated as a violation.');
  process.exit(1);
}
