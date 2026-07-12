// ══════════════════════════════════════════════════════════════════
// @usrp/shared-security — Deterministic password-KDF self-check
//
// The real gate for the officer-credential hashing (no Kafka/PG — pure
// functions):
//   • hash → verify round-trips for the correct password;
//   • a wrong password verifies false;
//   • the digest is self-describing (scrypt$N$r$p$salt$hash);
//   • the salt is random → two hashes of the SAME password differ, yet both verify;
//   • verifyPassword NEVER throws — malformed / empty / wrong-scheme / tampered
//     digests all return false (fail closed);
//   • the plaintext never appears inside the digest.
//
//   npx tsx packages/shared-security/selfcheck/verify-password-kdf.ts
// ══════════════════════════════════════════════════════════════════

import { hashPassword, verifyPassword } from '../src/index.js';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('password KDF (scrypt) — deterministic proof');

const PASSWORD = 'Str0ng-Officer-Pass!';
const digest = hashPassword(PASSWORD);

// ── Shape: self-describing scrypt digest ──────────────────────────
const parts = digest.split('$');
check('digest has 6 $-separated fields', parts.length === 6, digest);
check('scheme tag is "scrypt"', parts[0] === 'scrypt');
check('N is a power of two', parts[1] === '16384');
check('r and p recorded', parts[2] === '8' && parts[3] === '1');
check('salt + hash are non-empty base64', (parts[4]?.length ?? 0) > 0 && (parts[5]?.length ?? 0) > 0);

// ── Round-trip ────────────────────────────────────────────────────
check('correct password verifies true', verifyPassword(PASSWORD, digest));
check('wrong password verifies false', !verifyPassword('wrong-password', digest));
check('empty password verifies false', !verifyPassword('', digest));
check('case-different password verifies false', !verifyPassword(PASSWORD.toLowerCase(), digest));

// ── Salt uniqueness ───────────────────────────────────────────────
const digest2 = hashPassword(PASSWORD);
check('same password → different digest (random salt)', digest !== digest2);
check('both independent digests still verify', verifyPassword(PASSWORD, digest) && verifyPassword(PASSWORD, digest2));

// ── Never-throws / fail-closed on bad input ───────────────────────
check('malformed digest (not enough fields) → false', !verifyPassword(PASSWORD, 'scrypt$16384$8'));
check('wrong scheme → false', !verifyPassword(PASSWORD, `bcrypt$16384$8$1$${parts[4]}$${parts[5]}`));
check('empty string digest → false', !verifyPassword(PASSWORD, ''));
check('garbage digest → false', !verifyPassword(PASSWORD, 'not-a-digest-at-all'));
check(
  'non-power-of-two N → false (no throw)',
  !verifyPassword(PASSWORD, `scrypt$12345$8$1$${parts[4]}$${parts[5]}`),
);
check(
  'tampered hash field → false',
  !verifyPassword(PASSWORD, `scrypt$16384$8$1$${parts[4]}$${Buffer.from('tampered').toString('base64')}`),
);

// ── Plaintext leakage ─────────────────────────────────────────────
check('plaintext password does NOT appear in the digest', !digest.includes(PASSWORD));

if (failures > 0) {
  console.error(`\n✗ password-KDF proof FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log('\n✓ password-KDF proof passed');
