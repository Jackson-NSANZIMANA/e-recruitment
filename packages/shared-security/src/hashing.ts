// ══════════════════════════════════════════════════════════════════
// @usrp/shared-security — Hashing & constant-time comparison
//
// hashNationalId produces the system-wide applicant key: an HMAC-SHA256
// of the raw National ID. The raw NID is NEVER stored — this 64-char hex
// digest is the only identifier that touches the database (matches the
// public_core.applicant_identities.national_id_hash varchar(64) column).
// ══════════════════════════════════════════════════════════════════

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { canonicalJson, type JsonValue } from './canonical.js';

/** Rwandan National ID: 16 digits. */
const NATIONAL_ID_PATTERN = /^\d{16}$/;

export class InvalidNationalIdError extends Error {
  constructor() {
    super('National ID must be exactly 16 digits');
    this.name = 'InvalidNationalIdError';
  }
}

export function isValidRwandanNationalId(raw: string): boolean {
  return NATIONAL_ID_PATTERN.test(raw.trim());
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: string, data: string | Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Derive the system-wide applicant key from a raw National ID.
 * Throws {@link InvalidNationalIdError} for malformed input so a bad NID
 * can never silently become a valid-looking hash.
 */
export function hashNationalId(rawNationalId: string, hmacKey: string): string {
  const normalized = rawNationalId.trim();
  if (!isValidRwandanNationalId(normalized)) {
    throw new InvalidNationalIdError();
  }
  return hmacSha256Hex(hmacKey, normalized); // 64 hex chars
}

/** Hash a phone number for lookup (matches public_core phone_number_hash). */
export function hashPhoneNumber(rawPhone: string, hmacKey: string): string {
  const normalized = rawPhone.replace(/[\s-]/g, '');
  return hmacSha256Hex(hmacKey, normalized);
}

/** SHA-256 of a canonically-serialized JSON value. */
export function canonicalHash(value: JsonValue): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Constant-time comparison of two hex digests. Returns false on any
 * length mismatch. Use for signature/hash verification to avoid timing
 * side-channels.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── Password KDF (scrypt) ──────────────────────────────────────────
//
// The first human-credential surface in USRP (officer login). We hash with
// Node's built-in scrypt (memory-hard, in node:crypto) rather than argon2 or
// bcrypt so shared packages keep their zero-runtime-dependency invariant — a
// native KDF dependency is rejected for that reason. The encoded digest is
// self-describing so cost parameters can be raised later without a migration:
//
//   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
//
// A raw password is NEVER stored, logged, or returned — only this digest, which
// lives in public_core.officer_accounts.credential. Keys are per-hash random
// salts; there is no system-wide secret (unlike hashNationalId's HMAC key).

/** scrypt cost parameters. N must be a power of two; 16384 ≈ 16 MiB working set. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
// scryptSync's default maxmem (32 MiB) is too small once N·r·p·128 grows; size
// it generously so raising N later does not start throwing.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function scryptHash(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

/**
 * Hash a plaintext password into a self-describing scrypt digest
 * (`scrypt$N$r$p$saltB64$hashB64`). Each call uses a fresh random salt, so
 * hashing the same password twice yields different digests. Store the returned
 * string as-is; never store the plaintext.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptHash(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/**
 * Verify a plaintext password against a digest produced by {@link hashPassword}.
 * Constant-time in the hash comparison (timingSafeEqual). NEVER throws: any
 * malformed / empty / wrong-scheme digest returns false, so a corrupt stored
 * credential fails closed rather than crashing the login path.
 */
export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const parts = encoded.split('$');
    if (parts.length !== 6) return false;
    const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (scheme !== 'scrypt') return false;
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (n <= 1 || (n & (n - 1)) !== 0 || r <= 0 || p <= 0) return false; // N must be a power of two
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = scryptHash(password, salt, n, r, p);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
