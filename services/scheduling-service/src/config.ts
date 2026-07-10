// ══════════════════════════════════════════════════════════════════
// scheduling-service — Configuration
//
// Loads runtime, the database, the PII encryption key — needed to decrypt the
// applicant's home district (an encrypted PII column) so a venue can be
// resolved — and the Ed25519 key that signs the verifiable slot-invitation QR
// (ADR-009). No G2G endpoints: venue assignment is a pure DB lookup against
// seeded reference data.
//
// The QR signing key is supplied base64-encoded (BASE64 of the PKCS#8 PEM) so a
// multi-line PEM survives environment transport intact. The public half is
// DERIVED here and exposed on a read endpoint for OFFLINE verification.
//
// KEY MANAGEMENT: in dev the key rides in an env var. In production this MUST be
// an HSM/KMS-held key — the private key never belonging on a host filesystem
// (same residual flagged for the audit-immutability owner-key). Tracked in
// ADR-009.
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import {
  loadDatabaseConfig,
  loadEnv,
  loadRuntimeConfig,
  string,
  type DatabaseConfig,
  type EnvSource,
  type RuntimeConfig,
} from '@usrp/shared-config';

export interface SchedulingSecurityConfig {
  /** pgcrypto symmetric key used to decrypt the home-district PII column. */
  readonly encryptionKey: string;
}

export interface SchedulingSigningConfig {
  /** Ed25519 private key (PKCS#8 PEM) used to sign slot invitations. */
  readonly qrSigningPrivateKeyPem: string;
  /** Derived Ed25519 public key (SPKI PEM) published for offline verification. */
  readonly qrSigningPublicKeyPem: string;
  /** Key identifier embedded in each token so verifiers select the right key. */
  readonly qrSigningKeyId: string;
}

export interface SchedulingServiceConfig {
  readonly runtime: RuntimeConfig;
  readonly database: DatabaseConfig;
  readonly security: SchedulingSecurityConfig;
  readonly signing: SchedulingSigningConfig;
}

export function loadSchedulingConfig(source: EnvSource = process.env): SchedulingServiceConfig {
  const env = loadEnv(
    {
      PII_ENCRYPTION_KEY: string({ minLength: 32, secret: true }),
      // BASE64 of the PKCS#8 PEM. minLength guards against an empty/truncated key.
      QR_SIGNING_PRIVATE_KEY_B64: string({ minLength: 40, secret: true }),
      QR_SIGNING_KEY_ID: string({ minLength: 1 }),
    },
    source,
  );

  const qrSigningPrivateKeyPem = Buffer.from(env.QR_SIGNING_PRIVATE_KEY_B64, 'base64').toString(
    'utf8',
  );
  // Fails loud at boot if the key is not a valid Ed25519 private key.
  const qrSigningPublicKeyPem = createPublicKey(qrSigningPrivateKeyPem)
    .export({ type: 'spki', format: 'pem' })
    .toString();

  return {
    runtime: loadRuntimeConfig('scheduling-service', source),
    database: loadDatabaseConfig(source),
    security: { encryptionKey: env.PII_ENCRYPTION_KEY },
    signing: {
      qrSigningPrivateKeyPem,
      qrSigningPublicKeyPem,
      qrSigningKeyId: env.QR_SIGNING_KEY_ID,
    },
  };
}
