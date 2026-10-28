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
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

// ── Personal-data rule (ADR-047 §3.5) ──────────────────────────────────────
//
// Both repositories are PUBLIC. The sandbox works from real captures held
// OUTSIDE git; this rule is what keeps a value from them, or any real
// person's, from being committed by mistake. It reads tracked CONTENT and
// reports file:line and the CLASS of finding only, never the value (the CI
// log is public too).
//
//   NID          a 16-digit Rwandan NID shape (1 · 19xx/20xx · 7|8 · 10 digits),
//                bare or spaced like the card, OUTSIDE the documented sandbox
//                block (serial starting 999: tools/g2g-sandbox/src/population/nid.ts);
//   JPEG         a base64 JPEG longer than 1 KiB (a portrait or signature);
//   PHONE        a Rwandan E.164 mobile number outside the synthetic range
//                +250 788 00x xxx.
//
// An exception needs an entry in PERSONAL_DATA_ALLOWLIST with a reason.

const NID_BARE = /(?<![0-9A-Za-z])1(?:19|20)\d{2}[78]\d{10}(?![0-9A-Za-z])/g;
const NID_SPACED = /(?<![0-9])1 (?:19|20)\d{2} [78] \d{7} \d \d{2}(?![0-9])/g;
const SYNTHETIC_NID = /^1\d{4}[78]999\d{7}$/;
// 1 KiB of JPEG bytes is 1366 base64 characters; "/9j/" is the base64 of FF D8 FF.
const BASE64_JPEG = /\/9j\/[A-Za-z0-9+/]{1362,}/g;
const E164_RW_MOBILE = /\+250[\s-]?7(?:[\s-]?\d){8}(?![0-9])/g;
const SYNTHETIC_MOBILE_DIGITS = /^25078800\d{4}$/;

/** { path, class, reason }: an accepted exception, reviewed like code. */
export const PERSONAL_DATA_ALLOWLIST = [];

const allowed = (path, kind) => PERSONAL_DATA_ALLOWLIST.some((entry) => entry.path === path && entry.class === kind);

/** Scan one file's text; returns [{ line, class }] with no values. */
export function scanPersonalData(path, text) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const hit = (kind) => { if (!allowed(path, kind)) findings.push({ path, line: i + 1, class: kind }); };
    for (const m of line.matchAll(NID_BARE)) if (!SYNTHETIC_NID.test(m[0])) hit('NID');
    for (const m of line.matchAll(NID_SPACED)) if (!SYNTHETIC_NID.test(m[0].replace(/ /g, ''))) hit('NID');
    if (line.match(BASE64_JPEG) !== null) hit('JPEG');
    for (const m of line.matchAll(E164_RW_MOBILE)) if (!SYNTHETIC_MOBILE_DIGITS.test(m[0].replace(/\D/g, ''))) hit('PHONE');
  });
  return findings;
}

function personalDataViolations(cwd, paths) {
  const findings = [];
  for (const path of paths) {
    if (path === 'pnpm-lock.yaml') continue;
    let buffer;
    try {
      buffer = readFileSync(join(cwd, path));
    } catch {
      continue; // deleted in the work tree but still in the index
    }
    if (buffer.subarray(0, 8192).includes(0)) continue; // binary
    findings.push(...scanPersonalData(path, buffer.toString('utf8')));
  }
  return findings;
}

function reportPersonalData(findings) {
  if (findings.length === 0) {
    console.log('check-tracked-secrets: OK — no personal data (NID / JPEG / phone) outside the synthetic ranges.');
    return 0;
  }
  console.error(`\ncheck-tracked-secrets: ${findings.length} personal-data finding(s) (values withheld):\n`);
  for (const f of findings) console.error(`  ✗ ${f.path}:${f.line}  ${f.class}`);
  console.error(`
  Replace the value with a synthetic one (NIDs: serial block 999…, phones:
  +250 788 00x xxx, images: generated placeholders), or add a reviewed entry to
  PERSONAL_DATA_ALLOWLIST. If a real person's value was ever committed, treat
  it as disclosed: tell the DPO, and plan a history rewrite.
`);
  return 1;
}

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

    // ── Personal-data rule: RED on each class, GREEN on synthetic values ──
    // Values are ASSEMBLED at runtime, so this script never holds one.
    git('rm', '-q', '--cached', '.env');
    const realShape = ['1', '1990', '8', '0000000', '0', '00'].join('');
    const synthetic = ['1', '2003', '8', '9990001', '0', '00'].join('');
    const jpeg = '/9j/' + 'A'.repeat(1400);
    writeFileSync(join(dir, 'clean.json'), JSON.stringify({ nid: synthetic, phone: '+250788000111', photo: '/9j/' + 'A'.repeat(200) }));
    git('add', 'clean.json');
    assert('synthetic NID, synthetic phone, small image: GREEN', personalDataViolations(dir, trackedFiles(dir)).length, 0);
    writeFileSync(join(dir, 'leak.json'), JSON.stringify({ nid: realShape }));
    git('add', 'leak.json');
    const nid = personalDataViolations(dir, trackedFiles(dir));
    assert('a real-shaped NID outside the block is RED', nid.length, 1);
    assert('  and the finding names the class, not the value', JSON.stringify(nid).includes(realShape), false);
    writeFileSync(join(dir, 'leak.json'), `{"doc": "${realShape.replace(/^(.)(.{4})(.)(.{7})(.)(.{2})$/, '$1 $2 $3 $4 $5 $6')}"}`);
    git('add', 'leak.json');
    assert('the spaced card form is RED', personalDataViolations(dir, trackedFiles(dir)).length, 1);
    writeFileSync(join(dir, 'leak.json'), JSON.stringify({ photo: jpeg }));
    git('add', 'leak.json');
    assert('a base64 JPEG over 1 KiB is RED', personalDataViolations(dir, trackedFiles(dir)).length, 1);
    writeFileSync(join(dir, 'leak.json'), JSON.stringify({ phone: '+250 72' + '0 000 000' }));
    git('add', 'leak.json');
    assert('an E.164 mobile outside the synthetic range is RED', personalDataViolations(dir, trackedFiles(dir)).length, 1);
    git('rm', '-q', '--cached', 'leak.json');
    assert('GREEN again once untracked', personalDataViolations(dir, trackedFiles(dir)).length, 0);

    console.log(failures === 0 ? '\nselftest: all assertions passed.' : `\nselftest: ${failures} FAILED.`);
    return failures === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const isSelftest = process.argv.includes('--selftest');
try {
  if (isSelftest) process.exit(selftest());
  const cwd = process.cwd();
  const paths = trackedFiles(cwd);
  const fileStatus = report(findViolations(paths));
  const dataStatus = reportPersonalData(personalDataViolations(cwd, paths));
  process.exit(fileStatus === 0 && dataStatus === 0 ? 0 : 1);
} catch (error) {
  // Fail closed. "We could not check" must never read as "there is nothing here".
  console.error(`check-tracked-secrets: could not inspect the git index — ${error.message}`);
  console.error('Failing closed: an unverifiable index is treated as a violation.');
  process.exit(1);
}
