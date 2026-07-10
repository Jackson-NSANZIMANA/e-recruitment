// ══════════════════════════════════════════════════════════════════
// @usrp/shared-auth — Deterministic auth-token self-check
//
// The real gate for this crypto (no Kafka/PG — pure functions):
//   • sign → verify round-trips; claims become the right Principal;
//   • tampered payload / tampered signature / wrong key → null;
//   • expired, wrong issuer, wrong audience, wrong namespace → null;
//   • an officer without a real Agency → null (shape violation);
//   • dbRoleForPrincipal maps all four roles correctly;
//   • makeAuthVerifier reads `Authorization: Bearer <token>`;
//   • withAuth returns 401 (no/invalid), 403 (wrong kind), passes otherwise.
//
//   npx tsx packages/shared-auth/selfcheck/verify-auth-token.ts
// ══════════════════════════════════════════════════════════════════

import type { IncomingHttpHeaders } from 'node:http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { HttpError, type RequestContext } from '@usrp/shared-http';
import {
  dbRoleForPrincipal,
  makeAuthVerifier,
  signAuthToken,
  verifyAuthToken,
  withAuth,
  type AuthTokenClaims,
  type Principal,
} from '../src/index.js';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const NOW = new Date('2026-07-10T12:00:00.000Z');
const OPTS = { now: NOW, expectedIssuer: 'usrp', expectedAudience: 'usrp-services' };

const OFFICER_CLAIMS: AuthTokenClaims = {
  v: 1,
  iss: 'usrp',
  aud: 'usrp-services',
  sub: 'officer-rdf-001',
  kind: 'officer',
  agency: 'RDF',
  roles: ['reviewer'],
  issuedAt: '2026-07-10T09:00:00.000Z',
  expiresAt: '2026-07-10T17:00:00.000Z',
};

const SYSTEM_CLAIMS: AuthTokenClaims = {
  v: 1,
  iss: 'usrp',
  aud: 'usrp-services',
  sub: 'svc-application',
  kind: 'system',
  issuedAt: '2026-07-10T09:00:00.000Z',
  expiresAt: '2026-07-10T17:00:00.000Z',
};

function fakeCtx(headers: IncomingHttpHeaders): RequestContext {
  return {
    method: 'GET',
    path: '/v1/applications',
    query: new URLSearchParams(),
    headers,
    correlationId: 'corr-1',
    requestId: 'req-1',
    json: async <T = unknown>(): Promise<T> => ({}) as T,
  };
}

async function statusOf(handler: () => Promise<{ status: number }> | { status: number }): Promise<number> {
  try {
    const result = await handler();
    return result.status;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

async function main(): Promise<void> {
  const keys = generateDeviceKeyPair();
  const otherKeys = generateDeviceKeyPair();
  const officerToken = signAuthToken(keys.privateKeyPem, OFFICER_CLAIMS);
  const systemToken = signAuthToken(keys.privateKeyPem, SYSTEM_CLAIMS);

  console.log('\n── 1. Round-trip → Principal ────────────────────────────────');
  check('token is namespaced + versioned', officerToken.startsWith('USRP-AUTH.v1.'));
  check('token has 4 dot-segments', officerToken.split('.').length === 4);
  const officer = verifyAuthToken(keys.publicKeyPem, officerToken, OPTS);
  check('officer token verifies', officer !== null);
  check(
    'officer principal shape',
    officer !== null &&
      officer.kind === 'officer' &&
      officer.agency === 'RDF' &&
      officer.subjectId === 'officer-rdf-001',
    JSON.stringify(officer),
  );
  const system = verifyAuthToken(keys.publicKeyPem, systemToken, OPTS);
  check(
    'system principal shape',
    system !== null && system.kind === 'system' && system.subjectId === 'svc-application',
    JSON.stringify(system),
  );

  console.log('\n── 2. Tamper + wrong-key rejection ──────────────────────────');
  const tamperedSig = `${officerToken.slice(0, -4)}${officerToken.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  check('tampered signature rejected', verifyAuthToken(keys.publicKeyPem, tamperedSig, OPTS) === null);
  const parts = officerToken.split('.');
  const forged = { ...OFFICER_CLAIMS, agency: 'RNP' as const };
  const forgedPayload = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url');
  const forgedToken = `${parts[0]}.${parts[1]}.${forgedPayload}.${parts[3]}`;
  check('mutated payload rejected', verifyAuthToken(keys.publicKeyPem, forgedToken, OPTS) === null);
  check('wrong public key rejected', verifyAuthToken(otherKeys.publicKeyPem, officerToken, OPTS) === null);

  console.log('\n── 3. Expiry + issuer/audience + namespace ──────────────────');
  check(
    'rejected after expiry',
    verifyAuthToken(keys.publicKeyPem, officerToken, { ...OPTS, now: new Date('2026-07-10T17:00:01.000Z') }) === null,
  );
  check(
    'wrong issuer rejected',
    verifyAuthToken(keys.publicKeyPem, officerToken, { ...OPTS, expectedIssuer: 'evil' }) === null,
  );
  check(
    'wrong audience rejected',
    verifyAuthToken(keys.publicKeyPem, officerToken, { ...OPTS, expectedAudience: 'other' }) === null,
  );
  check(
    'wrong namespace rejected',
    verifyAuthToken(keys.publicKeyPem, officerToken.replace('USRP-AUTH', 'USRP-SLOT'), OPTS) === null,
  );
  check('empty token rejected', verifyAuthToken(keys.publicKeyPem, '', OPTS) === null);
  check('3-segment token rejected', verifyAuthToken(keys.publicKeyPem, 'USRP-AUTH.v1.abc', OPTS) === null);

  console.log('\n── 4. Officer-without-agency shape violation ────────────────');
  const noAgency: AuthTokenClaims = { ...SYSTEM_CLAIMS, kind: 'officer' };
  const noAgencyToken = signAuthToken(keys.privateKeyPem, noAgency);
  check('officer claim without agency rejected', verifyAuthToken(keys.publicKeyPem, noAgencyToken, OPTS) === null);

  console.log('\n── 5. dbRoleForPrincipal (pure policy) ──────────────────────');
  const p = (agency: 'RDF' | 'RNP' | 'RCS'): Principal => ({
    kind: 'officer',
    subjectId: 's',
    agency,
    roles: [],
  });
  check('RDF → usrp_rdf_officer', dbRoleForPrincipal(p('RDF')) === 'usrp_rdf_officer');
  check('RNP → usrp_rnp_officer', dbRoleForPrincipal(p('RNP')) === 'usrp_rnp_officer');
  check('RCS → usrp_rcs_officer', dbRoleForPrincipal(p('RCS')) === 'usrp_rcs_officer');
  check(
    'system → usrp_system_service',
    dbRoleForPrincipal({ kind: 'system', subjectId: 's' }) === 'usrp_system_service',
  );

  console.log('\n── 6. makeAuthVerifier + withAuth enforcement ───────────────');
  const verify = makeAuthVerifier({
    publicKeyPem: keys.publicKeyPem,
    issuer: 'usrp',
    audience: 'usrp-services',
    now: () => NOW,
  });
  check('verifier reads Bearer header', verify({ authorization: `Bearer ${officerToken}` }) !== null);
  check('verifier case-insensitive scheme', verify({ authorization: `bearer ${officerToken}` }) !== null);
  check('verifier rejects missing header', verify({}) === null);
  check('verifier rejects non-bearer', verify({ authorization: officerToken }) === null);

  const okHandler = withAuth(verify, { kind: 'officer' }, () => ({ status: 200, body: { ok: true } }));
  check(
    'withAuth passes valid officer',
    (await statusOf(() => okHandler(fakeCtx({ authorization: `Bearer ${officerToken}` })))) === 200,
  );
  check(
    'withAuth 401 on missing token',
    (await statusOf(() => okHandler(fakeCtx({})))) === 401,
  );
  check(
    'withAuth 403 on wrong kind (system on officer route)',
    (await statusOf(() => okHandler(fakeCtx({ authorization: `Bearer ${systemToken}` })))) === 403,
  );
  const systemOnly = withAuth(verify, { kind: 'system' }, () => ({ status: 201 }));
  check(
    'withAuth 403 on wrong kind (officer on system route)',
    (await statusOf(() => systemOnly(fakeCtx({ authorization: `Bearer ${officerToken}` })))) === 403,
  );
  check(
    'withAuth passes valid system',
    (await statusOf(() => systemOnly(fakeCtx({ authorization: `Bearer ${systemToken}` })))) === 201,
  );

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('AUTH TOKEN + ENFORCEMENT PROVEN (deterministic) ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

await main();
process.exit(failures === 0 ? 0 : 1);
