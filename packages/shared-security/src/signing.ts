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
import type { PhysicalTestMetrics } from '@usrp/shared-types';
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
