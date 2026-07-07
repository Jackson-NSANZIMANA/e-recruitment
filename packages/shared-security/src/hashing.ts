// ══════════════════════════════════════════════════════════════════
// @usrp/shared-security — Hashing & constant-time comparison
//
// hashNationalId produces the system-wide applicant key: an HMAC-SHA256
// of the raw National ID. The raw NID is NEVER stored — this 64-char hex
// digest is the only identifier that touches the database (matches the
// public_core.applicant_identities.national_id_hash varchar(64) column).
// ══════════════════════════════════════════════════════════════════

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
