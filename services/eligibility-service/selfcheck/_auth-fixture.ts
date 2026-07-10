// ══════════════════════════════════════════════════════════════════
// eligibility-service selfcheck — shared auth fixture
//
// The eligibility front doors are service-internal now (require a valid SYSTEM
// bearer token). Importing this module (before loadEligibilityConfig) provisions
// an ephemeral issuer public key into the environment the config reads, and
// exposes a matching verifier + a ready-to-use system bearer token so each proof
// can boot its route and authenticate its POSTs.
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims, type AuthVerifier } from '@usrp/shared-auth';

const KEYS = generateDeviceKeyPair();

// Must run before any loadEligibilityConfig() call — set at import time.
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

/** A verifier bound to the fixture key + the config defaults (usrp/usrp-services). */
export const testVerifier: AuthVerifier = makeAuthVerifier({
  publicKeyPem: createPublicKey(KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  issuer: 'usrp',
  audience: 'usrp-services',
});

function mint(kind: 'system' | 'officer'): string {
  const base = {
    v: 1 as const, iss: 'usrp', aud: 'usrp-services', sub: `selfcheck-${kind}`,
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency: 'RDF', roles: [] } : { ...base, kind };
  return signAuthToken(KEYS.privateKeyPem, claims);
}

/** A valid system bearer token (the front door requires kind:'system'). */
export const SYSTEM_TOKEN = mint('system');
/** A valid officer token — used to prove wrong-kind principals get 403. */
export const OFFICER_TOKEN = mint('officer');
/** Authorization header carrying the system token. */
export const AUTH_HEADER: Record<string, string> = { authorization: `Bearer ${SYSTEM_TOKEN}` };
