// ══════════════════════════════════════════════════════════════════
// identity-service — Live applicant-auth self-check (ADR-018)
//
// Proves the citizen door end-to-end against live infra, THREE real
// services booted in-proc: identity-service (OTP + sessions + me-routes),
// iam-service (client-credentials token mint, ADR-016 — its first
// production-shaped consumer), and application-service (the cross-agency
// by-applicant read).
//
// What it asserts:
//   • OTP request → uniform 202; the code goes to the NIDA-registered
//     phone (LogSmsChannel captures it in-proc); an unknown NID gets the
//     SAME 202 and sends nothing (no enumeration);
//   • wrong code ×5 locks the challenge — the RIGHT code then fails too;
//     a fresh challenge authenticates → opaque session (D5), ~30 min;
//   • me/applications with the session → 200, the citizen's OWN
//     applications across agencies — never another applicant's; the
//     gateway authenticated to application-service with a REAL
//     client-credentials system token minted by the in-proc iam-service;
//   • an OFFICER token on the by-applicant route → 403 (the citizen door
//     never widens an officer's agency scope);
//   • logout revokes immediately (204 → 401 on reuse); a consumed code
//     never verifies again; garbage session tokens → 401;
//   • raw phone, plaintext OTP, and session token appear in NO response
//     (beyond the one issuance), NO bus event, NO DB row (digests only —
//     phone_number_hash + phone_verified_at stamped post-verification);
//   • erasure (ADR-015) hard-deletes the citizen's sessions AND OTP
//     challenges — the live session dies with the identity.
//
//   Run (repo root), Tier-1 up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   NIDA_BASE_URL=http://localhost:3100 NIDA_HMAC_SECRET=dev_nida_hmac_secret \
//   NATIONAL_ID_HMAC_KEY='dev_national_id_hmac_key_min_32_chars!!' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   npx tsx services/identity-service/selfcheck/verify-applicant-auth-slice.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair, hashNationalId, hashPassword } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';

// ── One in-test issuer keypair for ALL THREE services ─────────────
// iam-service signs (private); identity/application verify (public).
// Set BOTH BEFORE any service config loads.
const KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PRIVATE_KEY_B64'] = Buffer.from(KEYS.privateKeyPem, 'utf8').toString('base64');
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const { createIamService, loadIamConfig, serviceTokenRoutes } = await import('@usrp/iam-service');
const { createApplicationService, loadApplicationConfig, byApplicantRoute } = await import(
  '@usrp/application-service'
);
const {
  createApplicantAuthService,
  createIdentityService,
  createEraseIdentityService,
  loadIdentityConfig,
  applicantAuthRoutes,
  erasureRoute,
  LogSmsChannel,
  HttpApplicationsGateway,
  APPLICANT_SESSION_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
} = await import('../src/index.js');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Deterministic fixtures (ad180000 — unique to this proof) ──────
const CITIZEN_NID = '1200380123456789'; // UWIMANA Jean Pierre — in the NIDA mock, WITH a registered phone
const UNKNOWN_NID = '1200380123400000'; // valid shape, absent from the NIDA seed AND from USRP
const MOCK_PHONE_FRAGMENT = '380-X789'; // distinctive tail of the mock's registered phone

const CTRL_APPLICANT = 'ad180000-0000-4000-8000-000000000002'; // another citizen — must stay invisible
const CTRL_NID_HASH = 'ad18ad18'.repeat(8);
const RDF_CAMPAIGN = 'ad180000-0000-4000-8000-0000000000c1';
const RNP_CAMPAIGN = 'ad180000-0000-4000-8000-0000000000c2';
const RCS_CAMPAIGN = 'ad180000-0000-4000-8000-0000000000c3';
const RDF_APP = 'ad180000-0000-4000-8000-00000000a001';
const RNP_APP = 'ad180000-0000-4000-8000-00000000a002';
const CTRL_APP = 'ad180000-0000-4000-8000-00000000a003';
const RDF_CODE = 'RDF-99001';
const RNP_CODE = 'RNP-99001';
const CTRL_CODE = 'RCS-99001';

const PORTAL_CLIENT_ID = 'selfcheck.portal';
const PORTAL_SECRET = 'S3lfcheck#Portal!';
const PORTAL_SERVICE_ID = 'ad180000-0000-4000-8000-00000000c001';
const OFFICER_ID = 'ad180000-0000-4000-8000-00000000ff01';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function mintOfficer(): string {
  const claims: AuthTokenClaims = {
    v: 1,
    iss: 'usrp',
    aud: 'usrp-services',
    sub: OFFICER_ID,
    kind: 'officer',
    agency: 'RDF',
    roles: [],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  return signAuthToken(KEYS.privateKeyPem, claims);
}

const CITIZEN_NID_HASH = hashNationalId(
  CITIZEN_NID,
  process.env['NATIONAL_ID_HMAC_KEY'] ?? 'dev_national_id_hmac_key_min_32_chars!!',
);

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const schema of ['rdf_ops', 'rnp_ops', 'rcs_ops'] as const) {
      await tx`
        DELETE FROM ${tx(schema)}.application_status_history
        WHERE application_id IN (
          SELECT id FROM ${tx(schema)}.applications
          WHERE processing_code IN ${tx([RDF_CODE, RNP_CODE, CTRL_CODE])})`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE processing_code IN ${tx([RDF_CODE, RNP_CODE, CTRL_CODE])}`;
    }
    // Sessions/challenges of any identity we may delete below. (= ANY, not
    // the IN-helper — postgres.js renders the helper as identifiers inside
    // a parenthesized subquery.)
    const hashes = [CITIZEN_NID_HASH, CTRL_NID_HASH];
    await tx`
      DELETE FROM public_core.applicant_sessions WHERE applicant_id IN
        (SELECT id FROM public_core.applicant_identities
         WHERE national_id_hash = ANY(${hashes}) OR id = ${CTRL_APPLICANT})`;
    await tx`
      DELETE FROM public_core.applicant_otp_challenges WHERE applicant_id IN
        (SELECT id FROM public_core.applicant_identities
         WHERE national_id_hash = ANY(${hashes}) OR id = ${CTRL_APPLICANT})`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([RDF_CAMPAIGN, RNP_CAMPAIGN, RCS_CAMPAIGN])}`;
    await tx`
      DELETE FROM public_core.applicant_identities
      WHERE national_id_hash = ANY(${hashes}) OR id = ${CTRL_APPLICANT}`;
    await tx`DELETE FROM public_core.service_accounts WHERE client_id = ${PORTAL_CLIENT_ID}`;
  });
}

async function seed(applicantId: string): Promise<void> {
  // The control citizen + campaigns + applications. The main citizen's
  // identity row was created by the REAL verify-identity use case (caller
  // passes its id). Both apps for the main citizen are TERMINAL so the
  // erasure section's gate passes.
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (${CTRL_APPLICANT}, ${CTRL_NID_HASH}, 'x', 'x', 'x', 'x', 'FEMALE', 'WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${RDF_CAMPAIGN}, 'Applicant-auth RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
      (${RNP_CAMPAIGN}, 'Applicant-auth RNP', 'RNP', 'REGISTRATION_OPEN', '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
      (${RCS_CAMPAIGN}, 'Applicant-auth RCS', 'RCS', 'REGISTRATION_OPEN', '["GENERAL_ENLISTEE"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RDF_APP}, ${RDF_CODE}, ${applicantId}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT',
            'REJECTED'::rdf_ops.application_status)`;
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RNP_APP}, ${RNP_CODE}, ${applicantId}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
            'WITHDRAWN'::rnp_ops.application_status)`;
  await admin`
    INSERT INTO rcs_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${CTRL_APP}, ${CTRL_CODE}, ${CTRL_APPLICANT}, ${RCS_CAMPAIGN}, 'GENERAL_ENLISTEE',
            'SUBMITTED'::rcs_ops.application_status)`;
  // The portal's machine identity — seeded AS usrp_iam_service (the grant path).
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${sql('usrp_iam_service')}`;
    await tx`
      INSERT INTO public_core.service_accounts (service_id, client_id, credential, description)
      VALUES (${PORTAL_SERVICE_ID}, ${PORTAL_CLIENT_ID}, ${hashPassword(PORTAL_SECRET)}, 'selfcheck portal client')`;
  });
}

async function main(): Promise<void> {
  await cleanup();

  // ── Boot iam-service (token mint) + application-service (the read) ──
  const iamBus = new InMemoryEventBus();
  const iam = createIamService(loadIamConfig(), iamBus);
  const iamServer = await startHttpServer({
    serviceName: 'iam-applicant-auth-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: serviceTokenRoutes(iam.serviceToken),
    handleSignals: false,
  });
  const appConfig = loadApplicationConfig();
  const appService = createApplicationService(appConfig, new InMemoryEventBus());
  const appVerify = makeAuthVerifier({
    publicKeyPem: appConfig.auth.authPublicKeyPem,
    issuer: appConfig.auth.jwtIssuer,
    audience: appConfig.auth.jwtAudience,
  });
  const appServer = await startHttpServer({
    serviceName: 'application-applicant-auth-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [byApplicantRoute(appService.list, appVerify)],
    handleSignals: false,
  });

  // ── Boot identity-service: verify (to create the citizen), applicant
  // auth (the slice under test), and erasure (the integration check). ──
  const idConfig = loadIdentityConfig();
  const idBus = new InMemoryEventBus();
  const verifyService = createIdentityService(idConfig, idBus);
  const sms = new LogSmsChannel();
  const applicantAuth = createApplicantAuthService(idConfig, idBus, sms);
  const gateway = new HttpApplicationsGateway({
    iamBaseUrl: iamServer.url,
    applicationBaseUrl: appServer.url,
    clientId: PORTAL_CLIENT_ID,
    clientSecret: PORTAL_SECRET,
  });
  const idVerify = makeAuthVerifier({
    publicKeyPem: idConfig.auth.authPublicKeyPem,
    issuer: idConfig.auth.jwtIssuer,
    audience: idConfig.auth.jwtAudience,
  });
  const idServer = await startHttpServer({
    serviceName: 'identity-applicant-auth-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [
      ...applicantAuthRoutes(applicantAuth, gateway),
      erasureRoute(createEraseIdentityService(idConfig, idBus), idVerify),
    ],
    handleSignals: false,
  });
  console.log(`\niam ${iamServer.url} · application ${appServer.url} · identity ${idServer.url}`);

  // The citizen exists because the REAL NIDA-anchored verification says so.
  const created = await verifyService.verify({ rawNationalId: CITIZEN_NID, registrationChannel: 'WEB' });
  if (created.kind !== 'CREATED' && created.kind !== 'ALREADY_EXISTS') {
    throw new Error(`could not establish the citizen identity: ${created.kind}`);
  }
  const applicantId = created.applicantId;
  await seed(applicantId);

  async function post(
    path: string,
    body: Record<string, unknown>,
    token?: string,
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    const res = await fetch(`${idServer.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return { status: res.status, text, json };
  }

  async function me(token: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${idServer.url}/v1/applicants/me/applications`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, text: await res.text() };
  }

  const lastOtp = (): string => {
    const body = sms.sent[sms.sent.length - 1]?.body ?? '';
    return /\b(\d{6})\b/.exec(body)?.[1] ?? '';
  };

  try {
    console.log('\n── 1. OTP request → uniform 202; code to the NIDA phone; no enumeration ──');
    const req = await post('/v1/applicants/auth/otp/request', { nationalId: CITIZEN_NID, channel: 'WEB' });
    check('known citizen → 202 CHALLENGED', req.status === 202, `got ${req.status} ${req.text}`);
    check('one SMS captured, to the NIDA-registered phone', sms.sent.length === 1 && (sms.sent[0]?.destination.includes(MOCK_PHONE_FRAGMENT) ?? false));
    check('the SMS carries a 6-digit code', lastOtp().length === 6);
    check('202 response carries NO phone and NO code', !req.text.includes(MOCK_PHONE_FRAGMENT) && !req.text.includes(lastOtp()));
    const unknown = await post('/v1/applicants/auth/otp/request', { nationalId: UNKNOWN_NID, channel: 'WEB' });
    check('unknown NID → byte-identical 202', unknown.status === 202 && unknown.text === req.text, unknown.text);
    check('…and NOTHING was sent for it', sms.sent.length === 1);

    console.log(`\n── 2. Lockout: ${OTP_MAX_ATTEMPTS} wrong guesses kill the challenge ──`);
    const goodCode = lastOtp();
    const wrong = goodCode === '000000' ? '000001' : '000000';
    let last = { status: 0, text: '' };
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
      last = await post('/v1/applicants/auth/otp/verify', { nationalId: CITIZEN_NID, otp: wrong, channel: 'WEB' });
    }
    check(`wrong code ×${OTP_MAX_ATTEMPTS} → every one 401`, last.status === 401, `got ${last.status}`);
    const lockedGood = await post('/v1/applicants/auth/otp/verify', { nationalId: CITIZEN_NID, otp: goodCode, channel: 'WEB' });
    check('the RIGHT code on a locked challenge → 401', lockedGood.status === 401, `got ${lockedGood.status}`);

    console.log('\n── 3. Fresh challenge → authenticated: opaque DB session (D5) ──');
    await post('/v1/applicants/auth/otp/request', { nationalId: CITIZEN_NID, channel: 'WEB' });
    const auth = await post('/v1/applicants/auth/otp/verify', { nationalId: CITIZEN_NID, otp: lastOtp(), channel: 'WEB' });
    check('correct fresh code → 200 with a session', auth.status === 200 && typeof auth.json['sessionToken'] === 'string', `got ${auth.status} ${auth.text}`);
    const session = String(auth.json['sessionToken'] ?? '');
    const ttlMs = Date.parse(String(auth.json['expiresAt'])) - Date.now();
    check(
      `session expiry ≈ ${APPLICANT_SESSION_TTL_SECONDS}s out`,
      ttlMs > (APPLICANT_SESSION_TTL_SECONDS - 120) * 1000 && ttlMs <= APPLICANT_SESSION_TTL_SECONDS * 1000,
      `${Math.round(ttlMs / 1000)}s`,
    );
    const replay = await post('/v1/applicants/auth/otp/verify', { nationalId: CITIZEN_NID, otp: lastOtp(), channel: 'WEB' });
    check('replaying the consumed code → 401', replay.status === 401, `got ${replay.status}`);
    const stamped = await admin<{ phone_number_hash: string | null; phone_verified_at: Date | null }[]>`
      SELECT phone_number_hash, phone_verified_at FROM public_core.applicant_identities WHERE id = ${applicantId}`;
    check(
      'phone_number_hash + phone_verified_at stamped (digest only — 64 hex)',
      /^[0-9a-f]{64}$/.test(stamped[0]?.phone_number_hash ?? '') && stamped[0]?.phone_verified_at !== null,
    );

    console.log('\n── 4. THE LOOP: me/applications via a REAL iam-minted system token ──');
    const mine = await me(session);
    check('me/applications → 200', mine.status === 200, `got ${mine.status} ${mine.text}`);
    check('sees the RDF application', mine.text.includes(RDF_CODE));
    check('sees the RNP application (cross-agency)', mine.text.includes(RNP_CODE));
    check("does NOT see another citizen's application", !mine.text.includes(CTRL_CODE));
    check('response carries NO NID hash and NO phone', !mine.text.includes(CITIZEN_NID_HASH) && !mine.text.includes(MOCK_PHONE_FRAGMENT));

    console.log('\n── 5. The citizen door never widens an officer: by-applicant → 403 ──');
    const officerProbe = await fetch(
      `${appServer.url}/v1/applications/by-applicant?applicantId=${applicantId}`,
      { headers: { authorization: `Bearer ${mintOfficer()}` } },
    );
    check('officer token on the system-only read → 403', officerProbe.status === 403, `got ${officerProbe.status}`);

    console.log('\n── 6. Session hygiene: garbage → 401; logout revokes immediately ──');
    check('garbage session token → 401', (await me('not-a-real-token')).status === 401);
    const bye = await fetch(`${idServer.url}/v1/applicants/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session}` },
    });
    check('logout → 204', bye.status === 204, `got ${bye.status}`);
    check('the revoked session → 401 (opaque DB session = instant revocation)', (await me(session)).status === 401);

    console.log('\n── 7. Nothing secret on the bus ──');
    const allEvents = JSON.stringify(idBus.published);
    check('bus carries NO raw phone', !allEvents.includes(MOCK_PHONE_FRAGMENT));
    check('bus carries NO session token', !allEvents.includes(session));
    check('OTP_ISSUED + SESSION_ISSUED audits emitted', allEvents.includes('APPLICANT_OTP_ISSUED') && allEvents.includes('APPLICANT_SESSION_ISSUED'));

    console.log('\n── 8. Erasure integration (ADR-015): sessions + challenges die with the identity ──');
    // Establish a LIVE session first, then erase (both apps are terminal).
    await post('/v1/applicants/auth/otp/request', { nationalId: CITIZEN_NID, channel: 'WEB' });
    const auth2 = await post('/v1/applicants/auth/otp/verify', { nationalId: CITIZEN_NID, otp: lastOtp(), channel: 'WEB' });
    const session2 = String(auth2.json['sessionToken'] ?? '');
    check('second login works (fresh challenge)', auth2.status === 200);
    const erased = await fetch(`${idServer.url}/v1/identities/erasure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mintOfficer()}` },
      body: JSON.stringify({ applicantId }),
    });
    check('erasure of the (all-terminal) citizen → 200', erased.status === 200, `got ${erased.status} ${await erased.text()}`);
    const remnants = await admin<{ s: string; c: string }[]>`
      SELECT
        (SELECT count(*) FROM public_core.applicant_sessions WHERE applicant_id = ${applicantId})::text AS s,
        (SELECT count(*) FROM public_core.applicant_otp_challenges WHERE applicant_id = ${applicantId})::text AS c`;
    check('zero sessions + zero challenges survive erasure', remnants[0]?.s === '0' && remnants[0]?.c === '0', JSON.stringify(remnants[0]));
    check('the live session died with the identity → 401', (await me(session2)).status === 401);
  } finally {
    await cleanup();
    await Promise.all([idServer.stop(), appServer.stop(), iamServer.stop()]);
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('APPLICANT AUTH PROVEN (live) — OTP → session → own applications, across three real services ✓');
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
