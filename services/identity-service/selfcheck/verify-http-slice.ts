// ══════════════════════════════════════════════════════════════════
// identity-service — Live HTTP-transport self-check (ADR-005)
//
// Boots the real service over @usrp/shared-http on an ephemeral port and
// drives it through an actual TCP socket with fetch — proving the ingress
// end-to-end against live infrastructure (PostgreSQL as usrp_app + live
// usrp-nida-mock; InMemoryEventBus so we can inspect emitted events and
// correlation propagation). Repeatable: cleans its rows before and after.
// Exits non-zero on the first failed assertion.
//
//   Run (repo root), with the live Tier-1 stack up:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   NIDA_BASE_URL='http://localhost:3100' \
//   NIDA_HMAC_SECRET='dev_nida_hmac_secret' \
//   NATIONAL_ID_HMAC_KEY='dev_national_id_hmac_key_min_32_chars!!' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   pnpm --filter @usrp/identity-service selfcheck:http
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { generateDeviceKeyPair, hashNationalId } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { createIdentityService, loadIdentityConfig, verifyIdentityRoute } from '../src/index.js';

// Self-provision an ephemeral issuer key BEFORE loading config (the front door
// is service-internal now — every verify call needs a valid SYSTEM token).
const AUTH_KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(AUTH_KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

function mintToken(kind: 'system' | 'officer'): string {
  const base = {
    v: 1 as const, iss: 'usrp', aud: 'usrp-services', sub: `selfcheck-${kind}`,
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency: 'RDF', roles: [] } : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const CITIZEN_NID = '1200380123456789'; // seeded RWANDAN_CITIZEN
const UNKNOWN_NID = '1200380123400000'; // valid shape, absent from NIDA seed
const VERIFY_PATH = '/v1/identities/verify';
// Deterministic correlation id we expect to flow request → response → event.
const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup(hashes: readonly string[]): Promise<void> {
  await admin`DELETE FROM public_core.applicant_identities WHERE national_id_hash IN ${admin(hashes)}`;
}

async function main(): Promise<void> {
  const config = loadIdentityConfig();
  const bus = new InMemoryEventBus();
  const service = createIdentityService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });
  const SYSTEM_TOKEN = mintToken('system');

  const citizenHash = hashNationalId(CITIZEN_NID, config.security.nationalIdHmacKey);
  const unknownHash = hashNationalId(UNKNOWN_NID, config.security.nationalIdHmacKey);
  await cleanup([citizenHash, unknownHash]);

  const server = await startHttpServer({
    serviceName: 'identity-service-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [verifyIdentityRoute(service, verify)],
    readiness: async (): Promise<boolean> => {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    handleSignals: false,
  });
  const base = server.url;
  console.log(`\nServer listening at ${base}`);

  // Every response body text is captured so we can prove no raw NID leaks.
  const bodies: string[] = [];
  async function call(
    method: string,
    path: string,
    init?: { readonly headers?: Record<string, string>; readonly body?: string },
  ): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
    const res = await fetch(`${base}${path}`, {
      method,
      ...(init?.headers ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    const text = await res.text();
    bodies.push(text);
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, headers: res.headers };
  }

  // Every business POST carries a valid system bearer token (service-internal
  // front door). Auth-specific assertions below override this.
  const JSON_HEADERS: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${SYSTEM_TOKEN}`,
  };
  const asRecord = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

  try {
    console.log('\n── 1. POST valid citizen → 201 CREATED ───────────────────────');
    const r1 = await call('POST', VERIFY_PATH, {
      headers: { ...JSON_HEADERS, 'x-correlation-id': CORRELATION_ID },
      body: JSON.stringify({ nationalId: CITIZEN_NID, channel: 'WEB' }),
    });
    const b1 = asRecord(r1.json);
    check('status is 201', r1.status === 201, `got ${r1.status}`);
    check('body.status is CREATED', b1['status'] === 'CREATED', String(b1['status']));
    const applicantId = typeof b1['applicantId'] === 'string' ? b1['applicantId'] : '';
    check('applicantId is a UUID', /^[0-9a-f-]{36}$/.test(applicantId), applicantId);
    check('response echoes x-correlation-id', r1.headers.get('x-correlation-id') === CORRELATION_ID);
    check('response sets x-request-id', (r1.headers.get('x-request-id') ?? '').length === 36);
    check('body does NOT expose nationalIdHash', !('nationalIdHash' in b1));
    check(
      'NIDA_VERIFICATION_COMPLETED published with the inbound correlationId',
      bus.published.length === 1 &&
        bus.published[0]?.eventType === 'NIDA_VERIFICATION_COMPLETED' &&
        bus.published[0]?.correlationId === CORRELATION_ID,
    );

    console.log('\n── 2. Re-POST same NID → 200 ALREADY_EXISTS (idempotent) ─────');
    const r2 = await call('POST', VERIFY_PATH, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ nationalId: CITIZEN_NID, channel: 'WEB' }),
    });
    const b2 = asRecord(r2.json);
    check('status is 200', r2.status === 200, `got ${r2.status}`);
    check('body.status is ALREADY_EXISTS', b2['status'] === 'ALREADY_EXISTS', String(b2['status']));
    check('same applicantId returned', b2['applicantId'] === applicantId);
    check('no duplicate event published', bus.published.length === 1, `got ${bus.published.length}`);

    console.log('\n── 3. Unknown NID → 404 NOT_FOUND_IN_NIDA + audit event ──────');
    const r3 = await call('POST', VERIFY_PATH, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ nationalId: UNKNOWN_NID, channel: 'USSD' }),
    });
    const b3 = asRecord(r3.json);
    check('status is 404', r3.status === 404, `got ${r3.status}`);
    check('body.status is NOT_FOUND_IN_NIDA', b3['status'] === 'NOT_FOUND_IN_NIDA', String(b3['status']));
    check(
      'AUDIT_ENTRY published for the failed verification',
      bus.published.length === 2 && bus.published[1]?.eventType === 'AUDIT_ENTRY',
    );

    console.log('\n── 4. Input validation → 400 ────────────────────────────────');
    const malformed = await call('POST', VERIFY_PATH, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ nationalId: '123', channel: 'WEB' }),
    });
    check('malformed NID → 400 INVALID_NATIONAL_ID', malformed.status === 400 && asRecord(malformed.json)['error'] === 'INVALID_NATIONAL_ID', `${malformed.status} ${malformed.text}`);
    const noNid = await call('POST', VERIFY_PATH, { headers: JSON_HEADERS, body: JSON.stringify({ channel: 'WEB' }) });
    check('missing nationalId → 400 MISSING_NATIONAL_ID', noNid.status === 400 && asRecord(noNid.json)['error'] === 'MISSING_NATIONAL_ID', `${noNid.status} ${noNid.text}`);
    const badChannel = await call('POST', VERIFY_PATH, { headers: JSON_HEADERS, body: JSON.stringify({ nationalId: CITIZEN_NID, channel: 'ARMY' }) });
    check('invalid channel → 400 INVALID_CHANNEL', badChannel.status === 400 && asRecord(badChannel.json)['error'] === 'INVALID_CHANNEL', `${badChannel.status} ${badChannel.text}`);

    console.log('\n── 4b. Front door is service-internal (auth enforced) ────────');
    const noAuth = await call('POST', VERIFY_PATH, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nationalId: CITIZEN_NID, channel: 'WEB' }),
    });
    check('unauthenticated POST → 401', noAuth.status === 401, `got ${noAuth.status} ${noAuth.text}`);
    const officerToken = mintToken('officer');
    const officerCall = await call('POST', VERIFY_PATH, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${officerToken}` },
      body: JSON.stringify({ nationalId: CITIZEN_NID, channel: 'WALK_IN' }),
    });
    // ADR-012: the walk-in field officer's on-site NIDA lookup rides this same
    // route — an officer principal is ACCEPTED (the citizen already verified
    // above, so this resolves to the existing identity, proving idempotence
    // across caller kinds too).
    check(
      'officer token on verify route → 200 ALREADY_EXISTS (walk-in on-site lookup, ADR-012)',
      officerCall.status === 200 && asRecord(officerCall.json)['status'] === 'ALREADY_EXISTS',
      `got ${officerCall.status} ${officerCall.text}`,
    );

    console.log('\n── 5. Body / content-type handling ──────────────────────────');
    const wrongType = await call('POST', VERIFY_PATH, { headers: { ...JSON_HEADERS, 'content-type': 'text/plain' }, body: 'hello' });
    check('non-JSON content-type → 415', wrongType.status === 415, `got ${wrongType.status}`);
    const badJson = await call('POST', VERIFY_PATH, { headers: JSON_HEADERS, body: '{ not json' });
    check('malformed JSON → 400 MALFORMED_JSON', badJson.status === 400 && asRecord(badJson.json)['error'] === 'MALFORMED_JSON', `${badJson.status} ${badJson.text}`);
    const emptyBody = await call('POST', VERIFY_PATH, { headers: JSON_HEADERS, body: '' });
    check('empty body → 400 EMPTY_BODY', emptyBody.status === 400 && asRecord(emptyBody.json)['error'] === 'EMPTY_BODY', `${emptyBody.status} ${emptyBody.text}`);

    console.log('\n── 6. Health, readiness, and routing ────────────────────────');
    const health = await call('GET', '/health');
    check('GET /health → 200 ok', health.status === 200 && asRecord(health.json)['status'] === 'ok');
    const ready = await call('GET', '/ready');
    check('GET /ready → 200 ready (DB reachable)', ready.status === 200 && asRecord(ready.json)['status'] === 'ready', `${ready.status} ${ready.text}`);
    const wrongMethod = await call('GET', VERIFY_PATH);
    check('GET on verify path → 405', wrongMethod.status === 405, `got ${wrongMethod.status}`);
    check('405 advertises Allow: POST', (wrongMethod.headers.get('allow') ?? '').includes('POST'), String(wrongMethod.headers.get('allow')));
    const unknown = await call('GET', '/does/not/exist');
    check('unknown route → 404', unknown.status === 404, `got ${unknown.status}`);

    console.log('\n── 7. The raw National ID never leaks ───────────────────────');
    const allBodies = bodies.join('\n');
    check('raw NID absent from every HTTP response body', !allBodies.includes(CITIZEN_NID) && !allBodies.includes(UNKNOWN_NID));
    const publishedJson = JSON.stringify(bus.published);
    check('raw NID absent from every published event', !publishedJson.includes(CITIZEN_NID) && !publishedJson.includes(UNKNOWN_NID));
  } finally {
    await cleanup([citizenHash, unknownHash]);
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('ALL IDENTITY HTTP-SLICE ASSERTIONS PASSED ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

main()
  .then(async () => {
    await Promise.all([sql.end(), admin.end()]);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    console.error('\nSELF-CHECK CRASHED:', err);
    await Promise.all([sql.end(), admin.end()]);
    process.exit(1);
  });
