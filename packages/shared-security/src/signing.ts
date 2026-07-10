// ══════════════════════════════════════════════════════════════════
// @usrp/shared-security — Ed25519 device signing (ADR-003)
//
// Field officers' tablets sign every physical-test score record with a
// device-held Ed25519 key. A compromised tablet cannot inject fabricated
// scores without a valid signature, and an accepted score is immutable —
// corrections are new signed records, never edits.
// ══════════════════════════════════════════════════════════════════

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import type { PhysicalTestMetrics, SlotInvitationClaims } from '@usrp/shared-types';
import { canonicalJson, type JsonValue } from './canonical.js';
import { canonicalHash, timingSafeEqualHex } from './hashing.js';

export interface Ed25519KeyPairPem {
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

/** Generate an Ed25519 keypair (PEM) for a field device. */
export function generateDeviceKeyPair(): Ed25519KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Sign arbitrary bytes with an Ed25519 private key; returns base64. */
export function signEd25519(privateKeyPem: string, data: Buffer): string {
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, data, key).toString('base64');
}

/** Verify an Ed25519 base64 signature over bytes. Never throws. */
export function verifyEd25519(publicKeyPem: string, data: Buffer, signatureB64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(null, data, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// ── Field score record signing ────────────────────────────────────
// The security-relevant fields that bind a score to a device, officer,
// applicant, and causal position (vector clock). Excludes the signature
// fields themselves.

export interface SignableFieldPayload {
  readonly applicationId: string;
  readonly qrInvitationCode: string;
  readonly metrics: PhysicalTestMetrics;
  readonly capturedAt: string;
  readonly deviceId: string;
  readonly capturingOfficerId: string;
  readonly vectorClock: Readonly<Record<string, number>>;
}

export interface FieldSignature {
  /** Ed25519 signature (base64) over the canonical signable payload. */
  readonly deviceSignature: string;
  /** SHA-256 (hex) of the canonical metrics payload. */
  readonly signedPayloadHash: string;
}

export function computeFieldPayloadHash(metrics: PhysicalTestMetrics): string {
  return canonicalHash(metrics as unknown as JsonValue);
}

export function signFieldScoreRecord(
  privateKeyPem: string,
  payload: SignableFieldPayload,
): FieldSignature {
  const canonical = canonicalJson(payload as unknown as JsonValue);
  return {
    deviceSignature: signEd25519(privateKeyPem, Buffer.from(canonical, 'utf8')),
    signedPayloadHash: computeFieldPayloadHash(payload.metrics),
  };
}

/** Verify both the device signature and the metrics hash of a record. */
export function verifyFieldScoreRecord(
  publicKeyPem: string,
  payload: SignableFieldPayload,
  signature: FieldSignature,
): boolean {
  const canonical = canonicalJson(payload as unknown as JsonValue);
  const signatureOk = verifyEd25519(
    publicKeyPem,
    Buffer.from(canonical, 'utf8'),
    signature.deviceSignature,
  );
  const hashOk = timingSafeEqualHex(
    signature.signedPayloadHash,
    computeFieldPayloadHash(payload.metrics),
  );
  return signatureOk && hashOk;
}

// ── Signed slot invitation (ADR-009) ──────────────────────────────
// A compact, self-contained, OFFLINE-verifiable credential for the exam-slot
// QR. Format (JWS-like but zero-dep and Ed25519-only):
//
//   USRP-SLOT.v1.<base64url(canonicalJson(claims))>.<base64url(ed25519 sig)>
//
// The signature covers "USRP-SLOT.v1.<payload>" so the header is bound too. A
// venue / biometric / physical-test stage verifies it with the scheduling
// public key alone — no DB round-trip — which is why the claims are fully
// self-describing (and PII-free: see SlotInvitationClaims).

const SLOT_INVITATION_NS = 'USRP-SLOT';
const SLOT_INVITATION_VER = 'v1';

export interface VerifySlotInvitationOptions {
  /** Clock used for the expiry check. Defaults to the current time. */
  readonly now?: Date;
}

/** Mint the signed, URL-safe slot-invitation token for a QR code. */
export function signSlotInvitation(privateKeyPem: string, claims: SlotInvitationClaims): string {
  const payload = Buffer.from(canonicalJson(claims as unknown as JsonValue), 'utf8').toString(
    'base64url',
  );
  const signingInput = `${SLOT_INVITATION_NS}.${SLOT_INVITATION_VER}.${payload}`;
  // signEd25519 returns base64; re-encode the raw signature bytes as base64url.
  const signatureUrl = Buffer.from(
    signEd25519(privateKeyPem, Buffer.from(signingInput, 'utf8')),
    'base64',
  ).toString('base64url');
  return `${signingInput}.${signatureUrl}`;
}

/**
 * Verify a slot-invitation token: returns the decoded claims iff the Ed25519
 * signature is valid AND the token has not expired; otherwise null. Never
 * throws (malformed input → null), so callers can treat null as "reject".
 */
export function verifySlotInvitation(
  publicKeyPem: string,
  token: string,
  options: VerifySlotInvitationOptions = {},
): SlotInvitationClaims | null {
  try {
    // The namespace itself contains a '.', so a valid token is exactly 4 parts:
    // "USRP-SLOT" . "v1" . <payload> . <signature>.
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [ns, ver, payload, signatureUrl] = parts as [string, string, string, string];
    if (ns !== SLOT_INVITATION_NS || ver !== SLOT_INVITATION_VER) return null;

    const signingInput = `${ns}.${ver}.${payload}`;
    const signatureB64 = Buffer.from(signatureUrl, 'base64url').toString('base64');
    if (!verifyEd25519(publicKeyPem, Buffer.from(signingInput, 'utf8'), signatureB64)) {
      return null;
    }

    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as SlotInvitationClaims;

    const expiresAtMs = Date.parse(claims.expiresAt);
    if (Number.isNaN(expiresAtMs)) return null;
    const nowMs = (options.now ?? new Date()).getTime();
    if (expiresAtMs <= nowMs) return null;

    return claims;
  } catch {
    return null;
  }
}
