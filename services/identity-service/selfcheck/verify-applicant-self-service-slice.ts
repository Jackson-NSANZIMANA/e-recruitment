// ══════════════════════════════════════════════════════════════════
// identity-service — Live applicant self-service self-check (ADR-020)
//
// Proves the citizen's OWN acts end-to-end against live infra, THREE
// real services booted in-proc: identity-service (session me-routes +
// erasure-request intake + the officer erasure road), iam-service
// (client-credentials mint), application-service (the withdraw-own
// system write + by-applicant read).
//
// The narrative IS the compliance story:
//   • the citizen logs in (OTP → opaque session) and files an erasure
//     request → 202 PENDING, idempotent re-file, audited once;
//   • the officer/DPO sees it in the queue but the gated erasure road
//     REFUSES — an application is still live (truthful 409);
//   • the citizen voluntarily withdraws that application (WITHDRAWN's
//     second writer: history performed_by 'APPLICANT', PII-free audit
//     cause APPLICANT_REQUEST); idempotent NO_CHANGE on repeat; a
//     foreign application → 404 (no ownership oracle); an immovable
//     terminal one → 409; officer/unauthenticated doors stay shut;
//   • NOW the erasure road executes (all-terminal gate passes BECAUSE
//     of the withdrawal) → identity tombstoned, session dead, and the
//     intake row is stamped EXECUTED by the accountable officer;
//   • the decline half: a PENDING request declined with a recorded
//     ground (audited), re-decline → 409, unknown → 404, and the
//     citizen may re-file after a decline;
//   • raw phone, NID hash, and session tokens appear in NO response
//     and NO bus event.
//
//   Run (repo root), Tier-1 up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   NIDA_BASE_URL=http://localhost:3100 NIDA_HMAC_SECRET=dev_nida_hmac_secret \
//   NATIONAL_ID_HMAC_KEY='dev_national_id_hmac_key_min_32_chars!!' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   npx tsx services/identity-service/selfcheck/verify-applicant-self-service-slice.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair, hashNationalId, hashPassword } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';

// ── One in-test issuer keypair for ALL THREE services ─────────────
const KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PRIVATE_KEY_B64'] = Buffer.from(KEYS.privateKeyPem, 'utf8').toString('base64');
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const { createIamService, loadIamConfig, serviceTokenRoutes } = await import('@usrp/iam-service');
const { createApplicationService, loadApplicationConfig, byApplicantRoute, withdrawOwnRoute } =
  await import('@usrp/application-service');
const {
  createApplicantAuthService,
  createIdentityService,
  createEraseIdentityService,
  createErasureRequestService,
  loadIdentityConfig,
  applicantAuthRoutes,
  erasureRoute,
  erasureRequestRoutes,
  LogSmsChannel,
  HttpApplicationsGateway,
} = await import('../src/index.js');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Deterministic fixtures (ad200000 — unique to this proof) ──────
const CITIZEN_NID = '1199980345678901'; // HABIMANA Eric — NIDA mock, registered phone
const MOCK_PHONE_FRAGMENT = '980-X901'; // distinctive tail of that phone

const CTRL_APPLICANT = 'ad200000-0000-4000-8000-000000000002'; // owns the foreign application
const CTRL_NID_HASH = 'ad20ad20'.repeat(8);
const RDF_CAMPAIGN = 'ad200000-0000-4000-8000-0000000000c1';
const RNP_CAMPAIGN = 'ad200000-0000-4000-8000-0000000000c2';
const RCS_CAMPAIGN = 'ad200000-0000-4000-8000-0000000000c3';
const RDF_APP = 'ad200000-0000-4000-8000-00000000a001'; // citizen's, SUBMITTED → withdrawn
const RNP_APP = 'ad200000-0000-4000-8000-00000000a002'; // citizen's, REJECTED (immovable)
const CTRL_APP = 'ad200000-0000-4000-8000-00000000a003'; // control's — the 404 target
const RDF_CODE = 'RDF-99201';
const RNP_CODE = 'RNP-99201';
const CTRL_CODE = 'RCS-99201';

const PORTAL_CLIENT_ID = 'selfcheck.selfservice';
const PORTAL_SECRET = 'S3lfcheck#SelfSvc!';
const PORTAL_SERVICE_ID = 'ad200000-0000-4000-8000-00000000c001';
const OFFICER_ID = 'ad200000-0000-4000-8000-00000000ff01';

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
    // (= ANY, not the IN-helper — postgres.js renders the helper as
    // identifiers inside a parenthesized subquery.)
    const hashes = [CITIZEN_NID_HASH, CTRL_NID_HASH];
    await tx`
      DELETE FROM public_core.erasure_requests WHERE applicant_id IN
        (SELECT id FROM public_core.applicant_identities
         WHERE national_id_hash = ANY(${hashes}) OR id = ${CTRL_APPLICANT})`;
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
      (${RDF_CAMPAIGN}, 'Self-service RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-10-01', '2026-10-15', 7),
      (${RNP_CAMPAIGN}, 'Self-service RNP', 'RNP', 'REGISTRATION_OPEN', '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days', '2026-10-01', '2026-10-15', 7),
      (${RCS_CAMPAIGN}, 'Self-service RCS', 'RCS', 'REGISTRATION_OPEN', '["GENERAL_ENLISTEE"]',
       now() - interval '1 day', now() + interval '30 days', '2026-10-01', '2026-10-15', 7)`;
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RDF_APP}, ${RDF_CODE}, ${applicantId}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT',
            'SUBMITTED'::rdf_ops.application_status)`;
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RNP_APP}, ${RNP_CODE}, ${applicantId}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
            'REJECTED'::rnp_ops.application_status)`;
  await admin`
    INSERT INTO rcs_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${CTRL_APP}, ${CTRL_CODE}, ${CTRL_APPLICANT}, ${RCS_CAMPAIGN}, 'GENERAL_ENLISTEE',
            'SUBMITTED'::rcs_ops.application_status)`;
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${sql('usrp_iam_service')}`;
    await tx`
      INSERT INTO public_core.service_accounts (service_id, client_id, credential, description)
      VALUES (${PORTAL_SERVICE_ID}, ${PORTAL_CLIENT_ID}, ${hashPassword(PORTAL_SECRET)}, 'selfcheck self-service client')`;
  });
}

async function main(): Promise<void> {
  await cleanup();

  // ── Boot iam (mint) + application (withdraw-own write + read) ─────
  const iamBus = new InMemoryEventBus();
  const iam = createIamService(loadIamConfig(), iamBus);
  const iamServer = await startHttpServer({
    serviceName: 'iam-selfservice-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: serviceTokenRoutes(iam.serviceToken),
    handleSignals: false,
  });
  const appConfig = loadApplicationConfig();
  const appBus = new InMemoryEventBus();
  const appService = createApplicationService(appConfig, appBus);
  const appVerify = makeAuthVerifier({
    publicKeyPem: appConfig.auth.authPublicKeyPem,
    issuer: appConfig.auth.jwtIssuer,
    audience: appConfig.auth.jwtAudience,
  });
  const appServer = await startHttpServer({
    serviceName: 'application-selfservice-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [
      byApplicantRoute(appService.list, appVerify),
      withdrawOwnRoute(appService.selfWithdrawal, appVerify),
    ],
    handleSignals: false,
  });

  // ── Boot identity: applicant auth + intake + the erasure road ─────
  const idConfig = loadIdentityConfig();
  const idBus = new InMemoryEventBus();
  const verifyService = createIdentityService(idConfig, idBus);
  const sms = new LogSmsChannel();
  const applicantAuth = createApplicantAuthService(idConfig, idBus, sms);
  const erasureRequests = createErasureRequestService(idConfig, idBus);
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
    serviceName: 'identity-selfservice-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [
      ...applicantAuthRoutes(applicantAuth, gateway),
      erasureRoute(createEraseIdentityService(idConfig, idBus), idVerify),
      ...erasureRequestRoutes(erasureRequests, applicantAuth, idVerify),
    ],
    handleSignals: false,
  });
  console.log(`\niam ${iamServer.url} · application ${appServer.url} · identity ${idServer.url}`);

  const created = await verifyService.verify({ rawNationalId: CITIZEN_NID, registrationChannel: 'WEB' });
  if (created.kind !== 'CREATED' && created.kind !== 'ALREADY_EXISTS') {
    throw new Error(`could not establish the citizen identity: ${created.kind}`);
  }
  const applicantId = created.applicantId;
  await seed(applicantId);

  async function idFetch(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: Record<string, unknown>; token?: string } = {},
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    const res = await fetch(`${idServer.url}${path}`, {
      method,
      headers: {
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
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

  const lastOtp = (): string => {
    const body = sms.sent[sms.sent.length - 1]?.body ?? '';
    return /\b(\d{6})\b/.exec(body)?.[1] ?? '';
  };

  async function login(): Promise<string> {
    await idFetch('POST', '/v1/applicants/auth/otp/request', {
      body: { nationalId: CITIZEN_NID, channel: 'WEB' },
    });
    const auth = await idFetch('POST', '/v1/applicants/auth/otp/verify', {
      body: { nationalId: CITIZEN_NID, otp: lastOtp(), channel: 'WEB' },
    });
    if (auth.status !== 200) throw new Error(`login failed: ${auth.status} ${auth.text}`);
    return String(auth.json['sessionToken'] ?? '');
  }

  const officer = mintOfficer();

  try {
    console.log('\n── 1. The citizen logs in and files their erasure demand ──');
    const session = await login();
    const filed = await idFetch('POST', '/v1/applicants/me/erasure-request', { token: session });
    check('file → 202 PENDING with a requestId', filed.status === 202 && typeof filed.json['requestId'] === 'string', `got ${filed.status} ${filed.text}`);
    const requestId = String(filed.json['requestId'] ?? '');
    const refiled = await idFetch('POST', '/v1/applicants/me/erasure-request', { token: session });
    check('re-file → 202, SAME request (idempotent)', refiled.status === 202 && refiled.json['requestId'] === requestId, refiled.text);
    const mineReq = await idFetch('GET', '/v1/applicants/me/erasure-request', { token: session });
    check('own view → PENDING', mineReq.status === 200 && mineReq.json['status'] === 'PENDING', mineReq.text);
    const requestedAudits = JSON.stringify(idBus.published).split('ERASURE_REQUESTED').length - 1;
    check('ERASURE_REQUESTED audited exactly once (no re-file audit)', requestedAudits === 1, `${requestedAudits}`);
    check('unauthenticated file → 401', (await idFetch('POST', '/v1/applicants/me/erasure-request')).status === 401);

    console.log('\n── 2. The DPO sees the demand; the gated road truthfully refuses ──');
    const queue = await idFetch('GET', '/v1/identities/erasure-requests', { token: officer });
    check('officer queue lists the request', queue.status === 200 && queue.text.includes(requestId) && queue.text.includes(applicantId), `got ${queue.status}`);
    check('a citizen session cannot read the queue → 401', (await idFetch('GET', '/v1/identities/erasure-requests', { token: session })).status === 401);
    const premature = await idFetch('POST', '/v1/identities/erasure', { token: officer, body: { applicantId } });
    check('erasure while an application is live → 409 REFUSED_ACTIVE_APPLICATION', premature.status === 409 && premature.json['status'] === 'REFUSED_ACTIVE_APPLICATION', premature.text);
    const stillPending = await admin<{ status: string }[]>`
      SELECT status FROM public_core.erasure_requests WHERE id = ${requestId}`;
    check('the refused attempt leaves the request PENDING', stillPending[0]?.status === 'PENDING');

    console.log("\n── 3. The citizen's own act: voluntary withdrawal (WITHDRAWN's second writer) ──");
    const withdrawn = await idFetch('POST', '/v1/applicants/me/applications/withdraw', {
      token: session,
      body: { applicationId: RDF_APP },
    });
    check('withdraw own SUBMITTED application → 200 WITHDRAWN from SUBMITTED', withdrawn.status === 200 && withdrawn.json['status'] === 'WITHDRAWN' && withdrawn.json['fromStatus'] === 'SUBMITTED' && withdrawn.json['agency'] === 'RDF', withdrawn.text);
    const dbApp = await admin<{ status: string }[]>`
      SELECT status::text AS status FROM rdf_ops.applications WHERE id = ${RDF_APP}`;
    check('DB row is WITHDRAWN', dbApp[0]?.status === 'WITHDRAWN');
    const history = await admin<{ performed_by: string; reason: string }[]>`
      SELECT performed_by, reason FROM rdf_ops.application_status_history
      WHERE application_id = ${RDF_APP} AND to_status = 'WITHDRAWN'`;
    check("history appended, performed_by 'APPLICANT' (a citizen act)", history.length === 1 && history[0]?.performed_by === 'APPLICANT', JSON.stringify(history));
    const appEvents = JSON.stringify(appBus.published);
    check('audited: APPLICATION_WITHDRAWN, cause APPLICANT_REQUEST, by the data subject', appEvents.includes('APPLICATION_WITHDRAWN') && appEvents.includes('APPLICANT_REQUEST') && appEvents.includes(applicantId));

    console.log('\n── 4. The door holds its shape: idempotent, owned, terminal, shut ──');
    const again = await idFetch('POST', '/v1/applicants/me/applications/withdraw', { token: session, body: { applicationId: RDF_APP } });
    check('withdraw again → 200 NO_CHANGE (idempotent)', again.status === 200 && again.json['status'] === 'NO_CHANGE', again.text);
    const historyCount = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM rdf_ops.application_status_history
      WHERE application_id = ${RDF_APP} AND to_status = 'WITHDRAWN'`;
    check('…and no duplicate history row', historyCount[0]?.n === '1');
    const withdrawnAudits = JSON.stringify(appBus.published).split('APPLICATION_WITHDRAWN').length - 1;
    check('…and no duplicate audit', withdrawnAudits === 1, `${withdrawnAudits}`);
    const foreign = await idFetch('POST', '/v1/applicants/me/applications/withdraw', { token: session, body: { applicationId: CTRL_APP } });
    check("someone else's application → 404 (no ownership oracle)", foreign.status === 404, `got ${foreign.status}`);
    const immovable = await idFetch('POST', '/v1/applicants/me/applications/withdraw', { token: session, body: { applicationId: RNP_APP } });
    check('own REJECTED application → 409 NOT_APPLICABLE', immovable.status === 409 && immovable.json['currentStatus'] === 'REJECTED', immovable.text);
    check('malformed applicationId → 400', (await idFetch('POST', '/v1/applicants/me/applications/withdraw', { token: session, body: { applicationId: 'nope' } })).status === 400);
    check('no session → 401', (await idFetch('POST', '/v1/applicants/me/applications/withdraw', { body: { applicationId: RDF_APP } })).status === 401);
    const officerProbe = await fetch(`${appServer.url}/v1/applications/withdraw-own`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${officer}` },
      body: JSON.stringify({ applicantId, applicationId: RDF_APP }),
    });
    check('an OFFICER token on the system write → 403 (citizen authority only)', officerProbe.status === 403, `got ${officerProbe.status}`);

    console.log('\n── 5. Now the road is lawful: execute → tombstone + EXECUTED stamp ──');
    const erased = await idFetch('POST', '/v1/identities/erasure', { token: officer, body: { applicantId } });
    check('erasure after the withdrawal → 200 ERASED (the withdrawal unlocked the gate)', erased.status === 200 && erased.json['status'] === 'ERASED', erased.text);
    const stamped = await admin<{ status: string; decided_by: string | null }[]>`
      SELECT status, decided_by::text AS decided_by FROM public_core.erasure_requests WHERE id = ${requestId}`;
    check('the intake row is EXECUTED, decided by the accountable officer', stamped[0]?.status === 'EXECUTED' && stamped[0]?.decided_by === OFFICER_ID, JSON.stringify(stamped[0]));
    check('the citizen session died with the identity → 401', (await idFetch('GET', '/v1/applicants/me/erasure-request', { token: session })).status === 401);
    const emptyQueue = await idFetch('GET', '/v1/identities/erasure-requests', { token: officer });
    check('the queue no longer lists it', !emptyQueue.text.includes(requestId));

    console.log('\n── 6. The decline half: an accountable NO, and the right to re-file ──');
    // The control citizen's demand — filed through the use case directly
    // (their HTTP filing path is identical to §1; what's under test here
    // is the officer's decline).
    const ctrlFiled = await erasureRequests.file({
      applicantId: CTRL_APPLICANT,
      context: { correlationId: 'ad200000-cccc-4000-8000-000000000001', causationId: 'ad200000-cccc-4000-8000-000000000001' },
    });
    const ctrlRequestId = ctrlFiled.requestId;
    const badNote = await idFetch('POST', '/v1/identities/erasure-requests/decline', { token: officer, body: { requestId: ctrlRequestId, note: '' } });
    check('empty ground → 400 (a decline must say why)', badNote.status === 400, `got ${badNote.status}`);
    const declined = await idFetch('POST', '/v1/identities/erasure-requests/decline', {
      token: officer,
      body: { requestId: ctrlRequestId, note: 'Application still under active adjudication' },
    });
    check('decline with a ground → 200 DECLINED', declined.status === 200 && declined.json['status'] === 'DECLINED', declined.text);
    const declinedRow = await admin<{ status: string; decision_note: string | null }[]>`
      SELECT status, decision_note FROM public_core.erasure_requests WHERE id = ${ctrlRequestId}`;
    check('the row records DECLINED + the ground', declinedRow[0]?.status === 'DECLINED' && (declinedRow[0]?.decision_note ?? '').includes('adjudication'));
    check('ERASURE_REQUEST_DECLINED audited', JSON.stringify(idBus.published).includes('ERASURE_REQUEST_DECLINED'));
    const reDecline = await idFetch('POST', '/v1/identities/erasure-requests/decline', { token: officer, body: { requestId: ctrlRequestId, note: 'again' } });
    check('re-decline → 409 NOT_PENDING (the earlier decision stands)', reDecline.status === 409 && reDecline.json['currentStatus'] === 'DECLINED', reDecline.text);
    check('unknown requestId → 404', (await idFetch('POST', '/v1/identities/erasure-requests/decline', { token: officer, body: { requestId: 'ad200000-dead-4000-8000-000000000000', note: 'x' } })).status === 404);
    const refileAfterDecline = await erasureRequests.file({
      applicantId: CTRL_APPLICANT,
      context: { correlationId: 'ad200000-cccc-4000-8000-000000000002', causationId: 'ad200000-cccc-4000-8000-000000000002' },
    });
    check('a declined citizen may re-file (fresh PENDING)', refileAfterDecline.kind === 'FILED' && refileAfterDecline.requestId !== ctrlRequestId);

    console.log('\n── 7. Nothing secret anywhere ──');
    const allResponses = [filed, refiled, mineReq, queue, withdrawn, again, immovable, erased, declined].map((r) => r.text).join('');
    check('no NID hash and no phone fragment in ANY response', !allResponses.includes(CITIZEN_NID_HASH) && !allResponses.includes(MOCK_PHONE_FRAGMENT));
    const allBuses = JSON.stringify(idBus.published) + JSON.stringify(appBus.published);
    check('no phone and no session token on ANY bus', !allBuses.includes(MOCK_PHONE_FRAGMENT) && !allBuses.includes(session));
  } finally {
    await cleanup();
    await Promise.all([idServer.stop(), appServer.stop(), iamServer.stop()]);
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('APPLICANT SELF-SERVICE PROVEN (live) — withdraw own → erasure demand → DPO decision, across three real services ✓');
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
