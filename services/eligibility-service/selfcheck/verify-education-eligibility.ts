// ══════════════════════════════════════════════════════════════════
// eligibility-service — Live NESA education-eligibility self-check (ADR-005)
//
// Seeds a VERIFIED and a PENDING applicant-identity fixture, boots the
// education (NESA) gate over @usrp/shared-http on an ephemeral port with a
// REAL NesaHttpGateway pointed at the live usrp-nesa-mock, and drives it
// through a real socket with fetch — asserting every outcome branch, the
// RCS ≥70% science sub-rule (pass AND fail), fail-closed on a missing NESA
// record, the 503 path when NESA is unreachable, and the invariant that no
// PII (DOB, school, raw index) leaks into a response or an event.
// Repeatable: cleans its fixtures before and after; exits non-zero on the
// first failed assertion.
//
//   Run (repo root), Tier-1 Postgres + NESA mock up:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   NESA_BASE_URL='http://localhost:3101' NESA_HMAC_SECRET='dev_nesa_hmac_secret' \
//   pnpm --filter @usrp/eligibility-service selfcheck:education
// ══════════════════════════════════════════════════════════════════

import { randomUUID, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, type EventBus } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { AUTH_HEADER, OFFICER_TOKEN, SYSTEM_TOKEN, testVerifier } from './_auth-fixture.js';
import {
  EDUCATION_CHECK_PATH,
  NesaHttpGateway,
  PgIdentityReader,
  VerifyNesaEducationService,
  educationCheckRoute,
} from '../src/index.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const ENCRYPTION_KEY = process.env['PII_ENCRYPTION_KEY'] ?? 'dev_pii_encryption_key_min_32_chars_ok!!';
const NESA_BASE_URL = process.env['NESA_BASE_URL'] ?? 'http://localhost:3101';
const NESA_HMAC_SECRET = process.env['NESA_HMAC_SECRET'] ?? 'dev_nesa_hmac_secret';

const FIXTURE_DOB = '2003-03-15';
const FIXTURE_SCHOOL = 'Groupe Scolaire Officiel de Butare'; // appears in a fixture payload; must never leak
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const APPLICATION_ID = '44444444-4444-4444-8444-444444444444';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Insert an applicant_identities fixture as the system service; return its id. */
async function seedIdentity(
  nationalIdHash: string,
  identityStatus: 'VERIFIED' | 'PENDING',
): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_system_service`;
    await tx`SELECT set_config('app.encryption_key', ${ENCRYPTION_KEY}, true)`;
    const rows = await tx<{ id: string }[]>`
      INSERT INTO public_core.applicant_identities
        (national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, gender,
         registration_channel, identity_status, nida_verification_request_id,
         nida_verified_at, nida_match_confidence, phone_number_hash)
      VALUES (
        ${nationalIdHash},
        pgp_sym_encrypt('Fixture Person', current_setting('app.encryption_key')),
        pgp_sym_encrypt(${FIXTURE_DOB},   current_setting('app.encryption_key')),
        pgp_sym_encrypt('GASABO',         current_setting('app.encryption_key')),
        pgp_sym_encrypt('KIGALI_CITY',    current_setting('app.encryption_key')),
        'MALE'::public_core.gender,
        'WEB'::public_core.application_channel,
        ${identityStatus}::public_core.identity_verification_status,
        ${randomUUID()}, now(), null, null
      )
      RETURNING id
    `;
    const row = rows[0];
    if (!row) throw new Error('fixture insert returned no row');
    return row.id;
  });
}

async function cleanup(hashes: readonly string[]): Promise<void> {
  await admin`DELETE FROM public_core.applicant_identities WHERE national_id_hash IN ${admin(hashes)}`;
}

/** Build an education route bound to a service using the given event bus + fetch. */
function buildRoute(bus: EventBus, fetchImpl?: typeof fetch) {
  const identityReader = new PgIdentityReader(ENCRYPTION_KEY);
  const nesaGateway = new NesaHttpGateway({
    baseUrl: NESA_BASE_URL,
    hmacSecret: NESA_HMAC_SECRET,
    timeoutMs: 5000,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const service = new VerifyNesaEducationService({ identityReader, nesaGateway, eventBus: bus });
  return educationCheckRoute(service, testVerifier);
}

async function main(): Promise<void> {
  const hashVerified = randomBytes(32).toString('hex');
  const hashPending = randomBytes(32).toString('hex');
  await cleanup([hashVerified, hashPending]);
  const verifiedId = await seedIdentity(hashVerified, 'VERIFIED');
  const pendingId = await seedIdentity(hashPending, 'PENDING');
  console.log(`\nSeeded VERIFIED ${verifiedId} + PENDING ${pendingId} — NESA mock ${NESA_BASE_URL}`);

  const bus = new InMemoryEventBus();
  const server = await startHttpServer({
    serviceName: 'eligibility-education-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [buildRoute(bus)],
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

  const bodies: string[] = [];
  // Business POSTs carry a valid system bearer token; a caller can override the
  // Authorization header to exercise the auth failure paths.
  async function call(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
    const res = await fetch(`${base}${EDUCATION_CHECK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...headers },
      body: JSON.stringify(body),
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

  try {
    console.log('\n── 1. A-Level pass: A2 meets GENERAL_ENLISTMENT → EVALUATED ELIGIBLE ──');
    const r1 = await call(
      { applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/1001' },
      { 'x-correlation-id': CORRELATION_ID },
    );
    const b1 = asRecord(r1.json);
    check('status is 200', r1.status === 200, `got ${r1.status} ${r1.text}`);
    check('status is EVALUATED', b1['status'] === 'EVALUATED', String(b1['status']));
    check('academicStatus ELIGIBLE', b1['academicStatus'] === 'ELIGIBLE', String(b1['academicStatus']));
    check('eligible true', b1['eligible'] === true);
    check('agency RDF', b1['agency'] === 'RDF', String(b1['agency']));
    check('evaluatedLevel A_LEVEL_A2', b1['evaluatedLevel'] === 'A_LEVEL_A2', String(b1['evaluatedLevel']));
    check('response body carries NO schoolName', !r1.text.includes(FIXTURE_SCHOOL));
    check('response echoes x-correlation-id', r1.headers.get('x-correlation-id') === CORRELATION_ID);
    check(
      'NESA_VERIFICATION_COMPLETED + AUDIT_ENTRY both published with inbound correlationId',
      bus.published.length === 2 &&
        bus.published.some((e) => e.eventType === 'NESA_VERIFICATION_COMPLETED' && e.correlationId === CORRELATION_ID) &&
        bus.published.some((e) => e.eventType === 'AUDIT_ENTRY' && e.correlationId === CORRELATION_ID),
      `published ${bus.published.map((e) => e.eventType).join(',')}`,
    );

    console.log('\n── 2. RCS 4-year science ≥70% PASS (82%) → ELIGIBLE ──');
    const r2 = await call({ applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'OFFICER_FOUR_YEAR_UR', nesaIndexNumber: 'RW2024/SCI-PASS' });
    const b2 = asRecord(r2.json);
    check('status 200 EVALUATED', r2.status === 200 && b2['status'] === 'EVALUATED', `${r2.status} ${r2.text}`);
    check('academicStatus ELIGIBLE (science 82% ≥ 70%)', b2['academicStatus'] === 'ELIGIBLE', String(b2['academicStatus']));
    check('agency RCS', b2['agency'] === 'RCS', String(b2['agency']));

    console.log('\n── 3. RCS 4-year science < 70% (61%) → INELIGIBLE ──');
    const r3 = await call({ applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'OFFICER_FOUR_YEAR_UR', nesaIndexNumber: 'RW2024/SCI-LOW' });
    const b3 = asRecord(r3.json);
    check('status 200 EVALUATED', r3.status === 200 && b3['status'] === 'EVALUATED', `${r3.status} ${r3.text}`);
    check('academicStatus INELIGIBLE (science 61% < 70%)', b3['academicStatus'] === 'INELIGIBLE', String(b3['academicStatus']));
    check('eligible false', b3['eligible'] === false);

    console.log('\n── 4. Bogus index → 422 NESA_RECORD_NOT_FOUND (+ INELIGIBLE events) ──');
    const before = bus.published.length;
    const r4 = await call({ applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/NOPE' });
    check('status 422 NESA_RECORD_NOT_FOUND', r4.status === 422 && asRecord(r4.json)['status'] === 'NESA_RECORD_NOT_FOUND', `${r4.status} ${r4.text}`);
    const emitted = bus.published.slice(before);
    check(
      'still emits NESA_VERIFICATION_COMPLETED (INELIGIBLE) + AUDIT_ENTRY',
      emitted.length === 2 &&
        emitted.some((e) => e.eventType === 'NESA_VERIFICATION_COMPLETED' && e.academicStatus === 'INELIGIBLE'),
      `emitted ${emitted.map((e) => e.eventType).join(',')}`,
    );

    console.log('\n── 5. Degree category on NESA path → 409 NESA_NOT_APPLICABLE ──');
    const r5 = await call({ applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'CADET_OFFICER', nesaIndexNumber: 'RW2024/1001' });
    check('status 409 NESA_NOT_APPLICABLE', r5.status === 409 && asRecord(r5.json)['status'] === 'NESA_NOT_APPLICABLE', `${r5.status} ${r5.text}`);

    console.log('\n── 6. Unverified identity → 409 IDENTITY_NOT_VERIFIED (no event) ──');
    const before6 = bus.published.length;
    const r6 = await call({ applicantId: pendingId, applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/1001' });
    check('status 409 IDENTITY_NOT_VERIFIED', r6.status === 409 && asRecord(r6.json)['status'] === 'IDENTITY_NOT_VERIFIED', `${r6.status} ${r6.text}`);
    check('no event published for rejected precondition', bus.published.length === before6, `+${bus.published.length - before6}`);

    console.log('\n── 7. Unknown applicant → 404 ──');
    const r7 = await call({ applicantId: randomUUID(), applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/1001' });
    check('status 404 APPLICANT_NOT_FOUND', r7.status === 404 && asRecord(r7.json)['status'] === 'APPLICANT_NOT_FOUND', `${r7.status} ${r7.text}`);

    console.log('\n── 8. Input validation → 400 ──');
    const badId = await call({ applicantId: 'nope', applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/1001' });
    check('bad applicantId → 400 INVALID_APPLICANT_ID', badId.status === 400 && asRecord(badId.json)['error'] === 'INVALID_APPLICANT_ID', `${badId.status} ${badId.text}`);
    const badCat = await call({ applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'NOPE', nesaIndexNumber: 'RW2024/1001' });
    check('bad category → 400 INVALID_CATEGORY', badCat.status === 400 && asRecord(badCat.json)['error'] === 'INVALID_CATEGORY', `${badCat.status} ${badCat.text}`);
    const badIdx = await call({ applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: '!!' });
    check('bad index → 400 INVALID_NESA_INDEX', badIdx.status === 400 && asRecord(badIdx.json)['error'] === 'INVALID_NESA_INDEX', `${badIdx.status} ${badIdx.text}`);

    console.log('\n── 8b. Front door is service-internal (auth enforced) ──');
    const noAuth = await call(
      { applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/1001' },
      { authorization: 'Bearer not-a-valid-token' },
    );
    check('invalid token → 401', noAuth.status === 401, `got ${noAuth.status} ${noAuth.text}`);
    const wrongKind = await call(
      { applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/1001' },
      { authorization: `Bearer ${OFFICER_TOKEN}` },
    );
    check('officer token on system route → 403', wrongKind.status === 403, `got ${wrongKind.status} ${wrongKind.text}`);

    console.log('\n── 9. NESA unreachable → 503 NESA_UNAVAILABLE ──');
    const failBus = new InMemoryEventBus();
    const failFetch: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const failServer = await startHttpServer({
      serviceName: 'eligibility-education-selfcheck-fail',
      port: 0,
      host: '127.0.0.1',
      routes: [buildRoute(failBus, failFetch)],
      handleSignals: false,
    });
    try {
      const res = await fetch(`${failServer.url}${EDUCATION_CHECK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SYSTEM_TOKEN}` },
        body: JSON.stringify({ applicantId: verifiedId, applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2024/1001' }),
      });
      const txt = await res.text();
      bodies.push(txt);
      check('status 503 NESA_UNAVAILABLE', res.status === 503 && asRecord(JSON.parse(txt))['error'] === 'NESA_UNAVAILABLE', `${res.status} ${txt}`);
      check('no event published on NESA fault', failBus.published.length === 0, `got ${failBus.published.length}`);
    } finally {
      await failServer.stop();
    }

    console.log('\n── 10. No PII leaks (DOB / school) ──');
    const allBodies = bodies.join('\n');
    check('DOB absent from every HTTP response body', !allBodies.includes(FIXTURE_DOB));
    check('school name absent from every HTTP response body', !allBodies.includes(FIXTURE_SCHOOL));
    const publishedJson = JSON.stringify(bus.published);
    check('DOB absent from every published event', !publishedJson.includes(FIXTURE_DOB));
    check('school name absent from every published event', !publishedJson.includes(FIXTURE_SCHOOL));
  } finally {
    await cleanup([hashVerified, hashPending]);
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('ALL EDUCATION NESA-SLICE ASSERTIONS PASSED ✓');
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
