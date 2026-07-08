// ══════════════════════════════════════════════════════════════════
// eligibility-service — Live HEC degree-eligibility self-check (ADR-005)
//
// Seeds applicant-identity fixtures carrying the encrypted G2G subject hash
// (HMAC(NIDA-shared secret, NID)) — the token HEC binds a degree to — boots
// the degree (HEC) gate over @usrp/shared-http on an ephemeral port with a
// REAL HecHttpGateway pointed at the live usrp-hec-mock, and drives it
// through a real socket. Asserts: degree verified → ELIGIBLE (+ age
// exception surfaced); the specialist-field gate (pass AND fail); the
// holder-mismatch fraud signal; degree-not-found; the NESA-path rejection;
// fail-closed when an identity predates the G2G hash column; unverified /
// unknown applicants; input 400s; the 503 fault path; and that neither the
// G2G hash nor the registration number leaks into a response or an event.
// Repeatable: cleans fixtures before and after; exits non-zero on first
// failed assertion.
//
//   Run (repo root), Tier-1 Postgres + HEC mock up:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   HEC_BASE_URL='http://localhost:3103' HEC_HMAC_SECRET='dev_hec_hmac_secret' \
//   pnpm --filter @usrp/eligibility-service selfcheck:degree
// ══════════════════════════════════════════════════════════════════

import { randomUUID, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, type EventBus } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import {
  DEGREE_CHECK_PATH,
  HecHttpGateway,
  PgIdentityReader,
  VerifyHecEducationService,
  degreeCheckRoute,
} from '../src/index.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const ENCRYPTION_KEY = process.env['PII_ENCRYPTION_KEY'] ?? 'dev_pii_encryption_key_min_32_chars_ok!!';
const HEC_BASE_URL = process.env['HEC_BASE_URL'] ?? 'http://localhost:3103';
const HEC_HMAC_SECRET = process.env['HEC_HMAC_SECRET'] ?? 'dev_hec_hmac_secret';

// G2G subject hashes from the HEC/NIDA dev seed (HMAC(dev_nida_hmac_secret, NID)).
const G2G_UWIMANA = '6561ef4517673f33b321cf2004b9d8e31c805c0a927346a4c4b6a71a36b648b0'; // → UR/2023/CS/001 (ENGINEERING, BACHELOR)
const G2G_MUKAMANA = '64d32ed6e2852caa6f28017cd7dcff3c54dac8a1b31bf29f1105fe2f27cfb795'; // → UR/2022/NURSING/045 (NURSING, BACHELOR)

// Registrations in the live HEC mock (degrees.json).
const REG_ENG_BACHELOR = 'UR/2023/CS/001'; // holder UWIMANA, ENGINEERING, BACHELOR_A0
const REG_NURSING = 'UR/2022/NURSING/045'; // holder MUKAMANA, NURSING, BACHELOR_A0
const REG_UNKNOWN = 'UR/9999/XX/999';

const APPLICATION_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';

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

/** Insert an applicant_identities fixture (optionally with the encrypted G2G hash). */
async function seedIdentity(
  nationalIdHash: string,
  identityStatus: 'VERIFIED' | 'PENDING',
  nidaLookupHash: string | null,
): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_system_service`;
    await tx`SELECT set_config('app.encryption_key', ${ENCRYPTION_KEY}, true)`;
    const rows = await tx<{ id: string }[]>`
      INSERT INTO public_core.applicant_identities
        (national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, encrypted_nida_lookup_hash,
         gender, registration_channel, identity_status, nida_verification_request_id,
         nida_verified_at, nida_match_confidence, phone_number_hash)
      VALUES (
        ${nationalIdHash},
        pgp_sym_encrypt('Fixture Person', current_setting('app.encryption_key')),
        pgp_sym_encrypt('2001-07-22',     current_setting('app.encryption_key')),
        pgp_sym_encrypt('GASABO',         current_setting('app.encryption_key')),
        pgp_sym_encrypt('KIGALI_CITY',    current_setting('app.encryption_key')),
        ${
          nidaLookupHash === null
            ? tx`NULL`
            : tx`pgp_sym_encrypt(${nidaLookupHash}, current_setting('app.encryption_key'))`
        },
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

function buildRoute(bus: EventBus, fetchImpl?: typeof fetch) {
  const identityReader = new PgIdentityReader(ENCRYPTION_KEY);
  const hecGateway = new HecHttpGateway({
    baseUrl: HEC_BASE_URL,
    hmacSecret: HEC_HMAC_SECRET,
    timeoutMs: 5000,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const service = new VerifyHecEducationService({ identityReader, hecGateway, eventBus: bus });
  return degreeCheckRoute(service);
}

async function main(): Promise<void> {
  const hUwimana = randomBytes(32).toString('hex');
  const hMukamana = randomBytes(32).toString('hex');
  const hPending = randomBytes(32).toString('hex');
  const hNoHash = randomBytes(32).toString('hex');
  const allHashes = [hUwimana, hMukamana, hPending, hNoHash];
  await cleanup(allHashes);

  const uwimanaId = await seedIdentity(hUwimana, 'VERIFIED', G2G_UWIMANA);
  const mukamanaId = await seedIdentity(hMukamana, 'VERIFIED', G2G_MUKAMANA);
  const pendingId = await seedIdentity(hPending, 'PENDING', G2G_UWIMANA);
  const noHashId = await seedIdentity(hNoHash, 'VERIFIED', null);
  console.log(`\nSeeded fixtures — HEC mock ${HEC_BASE_URL}`);

  const bus = new InMemoryEventBus();
  const server = await startHttpServer({
    serviceName: 'eligibility-degree-selfcheck',
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
  async function call(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
    const res = await fetch(`${base}${DEGREE_CHECK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
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
    console.log('\n── 1. Degree verified, university category → EVALUATED ELIGIBLE + age exception ──');
    const r1 = await call(
      { applicantId: uwimanaId, applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_UNIVERSITY', hecRegistrationNumber: REG_ENG_BACHELOR },
      { 'x-correlation-id': CORRELATION_ID },
    );
    const b1 = asRecord(r1.json);
    check('status 200 EVALUATED', r1.status === 200 && b1['status'] === 'EVALUATED', `${r1.status} ${r1.text}`);
    check('academicStatus ELIGIBLE', b1['academicStatus'] === 'ELIGIBLE', String(b1['academicStatus']));
    check('agency RDF', b1['agency'] === 'RDF', String(b1['agency']));
    check('evaluatedLevel BACHELOR_A0', b1['evaluatedLevel'] === 'BACHELOR_A0', String(b1['evaluatedLevel']));
    check('appliedMaxAge 26 (university +1)', b1['appliedMaxAge'] === 26, String(b1['appliedMaxAge']));
    check('ageExceptionApplies true', b1['ageExceptionApplies'] === true);
    check(
      'HEC_VERIFICATION_COMPLETED + AUDIT_ENTRY both published with inbound correlationId',
      bus.published.length === 2 &&
        bus.published.some((e) => e.eventType === 'HEC_VERIFICATION_COMPLETED' && e.correlationId === CORRELATION_ID) &&
        bus.published.some((e) => e.eventType === 'AUDIT_ENTRY' && e.correlationId === CORRELATION_ID),
      `published ${bus.published.map((e) => e.eventType).join(',')}`,
    );
    const hecEvt = asRecord(bus.published.find((e) => e.eventType === 'HEC_VERIFICATION_COMPLETED'));
    check('event.degreeVerified true', hecEvt['degreeVerified'] === true);
    check('event carries institutionName', typeof hecEvt['institutionName'] === 'string');

    console.log('\n── 2. Specialist category, field recognised (ENGINEERING∈RDF) → ELIGIBLE ──');
    const r2 = await call({ applicantId: uwimanaId, applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_SPECIALIST', hecRegistrationNumber: REG_ENG_BACHELOR });
    const b2 = asRecord(r2.json);
    check('status 200 EVALUATED ELIGIBLE', r2.status === 200 && b2['academicStatus'] === 'ELIGIBLE', `${r2.status} ${r2.text}`);
    check('appliedMaxAge 27 (specialist +2)', b2['appliedMaxAge'] === 27, String(b2['appliedMaxAge']));
    check('specialistField ENGINEERING surfaced', b2['specialistField'] === 'ENGINEERING', String(b2['specialistField']));

    console.log('\n── 3. Specialist category, field NOT recognised (NURSING∉RDF) → INELIGIBLE ──');
    const r3 = await call({ applicantId: mukamanaId, applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_SPECIALIST', hecRegistrationNumber: REG_NURSING });
    const b3 = asRecord(r3.json);
    check('status 200 EVALUATED', r3.status === 200 && b3['status'] === 'EVALUATED', `${r3.status} ${r3.text}`);
    check('academicStatus INELIGIBLE (NURSING not an RDF specialist field)', b3['academicStatus'] === 'INELIGIBLE', String(b3['academicStatus']));
    check('eligible false', b3['eligible'] === false);

    console.log('\n── 4. Same degree, RCS specialist (NURSING∈RCS) → ELIGIBLE (per-agency field set) ──');
    const r4 = await call({ applicantId: mukamanaId, applicationId: APPLICATION_ID, category: 'OFFICER_ONE_YEAR_SPECIALIST', hecRegistrationNumber: REG_NURSING });
    const b4 = asRecord(r4.json);
    check('status 200 ELIGIBLE (NURSING recognised for RCS)', r4.status === 200 && b4['academicStatus'] === 'ELIGIBLE', `${r4.status} ${r4.text}`);
    check('agency RCS', b4['agency'] === 'RCS', String(b4['agency']));

    console.log('\n── 5. Holder mismatch: applicant presents another citizen’s degree → 422 ──');
    const before5 = bus.published.length;
    const r5 = await call({ applicantId: uwimanaId, applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_UNIVERSITY', hecRegistrationNumber: REG_NURSING });
    check('status 422 DEGREE_HOLDER_MISMATCH', r5.status === 422 && asRecord(r5.json)['status'] === 'DEGREE_HOLDER_MISMATCH', `${r5.status} ${r5.text}`);
    const emitted5 = bus.published.slice(before5);
    check(
      'still emits HEC_VERIFICATION_COMPLETED(degreeVerified=false) + AUDIT_ENTRY',
      emitted5.length === 2 &&
        emitted5.some((e) => e.eventType === 'HEC_VERIFICATION_COMPLETED' && asRecord(e)['degreeVerified'] === false),
      `emitted ${emitted5.map((e) => e.eventType).join(',')}`,
    );

    console.log('\n── 6. Unknown registration → 422 DEGREE_NOT_FOUND ──');
    const r6 = await call({ applicantId: uwimanaId, applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_UNIVERSITY', hecRegistrationNumber: REG_UNKNOWN });
    check('status 422 DEGREE_NOT_FOUND', r6.status === 422 && asRecord(r6.json)['status'] === 'DEGREE_NOT_FOUND', `${r6.status} ${r6.text}`);

    console.log('\n── 7. A-Level (NESA) category → 409 HEC_NOT_APPLICABLE ──');
    const r7 = await call({ applicantId: uwimanaId, applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', hecRegistrationNumber: REG_ENG_BACHELOR });
    check('status 409 HEC_NOT_APPLICABLE', r7.status === 409 && asRecord(r7.json)['status'] === 'HEC_NOT_APPLICABLE', `${r7.status} ${r7.text}`);

    console.log('\n── 8. Identity predates G2G hash column → 409 G2G_SUBJECT_UNAVAILABLE (fail closed) ──');
    const before8 = bus.published.length;
    const r8 = await call({ applicantId: noHashId, applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_UNIVERSITY', hecRegistrationNumber: REG_ENG_BACHELOR });
    check('status 409 G2G_SUBJECT_UNAVAILABLE', r8.status === 409 && asRecord(r8.json)['status'] === 'G2G_SUBJECT_UNAVAILABLE', `${r8.status} ${r8.text}`);
    check('no event published (no G2G call made)', bus.published.length === before8, `+${bus.published.length - before8}`);

    console.log('\n── 9. Unverified identity → 409, and unknown applicant → 404 (no events) ──');
    const before9 = bus.published.length;
    const r9a = await call({ applicantId: pendingId, applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_UNIVERSITY', hecRegistrationNumber: REG_ENG_BACHELOR });
    check('status 409 IDENTITY_NOT_VERIFIED', r9a.status === 409 && asRecord(r9a.json)['status'] === 'IDENTITY_NOT_VERIFIED', `${r9a.status} ${r9a.text}`);
    const r9b = await call({ applicantId: randomUUID(), applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_UNIVERSITY', hecRegistrationNumber: REG_ENG_BACHELOR });
    check('status 404 APPLICANT_NOT_FOUND', r9b.status === 404 && asRecord(r9b.json)['status'] === 'APPLICANT_NOT_FOUND', `${r9b.status} ${r9b.text}`);
    check('no event for rejected preconditions', bus.published.length === before9, `+${bus.published.length - before9}`);

    console.log('\n── 10. Input validation → 400 ──');
    const badId = await call({ applicantId: 'nope', applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_UNIVERSITY', hecRegistrationNumber: REG_ENG_BACHELOR });
    check('bad applicantId → 400 INVALID_APPLICANT_ID', badId.status === 400 && asRecord(badId.json)['error'] === 'INVALID_APPLICANT_ID', `${badId.status} ${badId.text}`);
    const badReg = await call({ applicantId: uwimanaId, applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_UNIVERSITY', hecRegistrationNumber: '!!' });
    check('bad registration → 400 INVALID_HEC_REGISTRATION', badReg.status === 400 && asRecord(badReg.json)['error'] === 'INVALID_HEC_REGISTRATION', `${badReg.status} ${badReg.text}`);

    console.log('\n── 11. HEC unreachable → 503 HEC_UNAVAILABLE (no event) ──');
    const failBus = new InMemoryEventBus();
    const failFetch: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const failServer = await startHttpServer({
      serviceName: 'eligibility-degree-selfcheck-fail',
      port: 0,
      host: '127.0.0.1',
      routes: [buildRoute(failBus, failFetch)],
      handleSignals: false,
    });
    try {
      const res = await fetch(`${failServer.url}${DEGREE_CHECK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applicantId: uwimanaId, applicationId: APPLICATION_ID, category: 'RESERVE_FORCE_UNIVERSITY', hecRegistrationNumber: REG_ENG_BACHELOR }),
      });
      const txt = await res.text();
      bodies.push(txt);
      check('status 503 HEC_UNAVAILABLE', res.status === 503 && asRecord(JSON.parse(txt))['error'] === 'HEC_UNAVAILABLE', `${res.status} ${txt}`);
      check('no event published on HEC fault', failBus.published.length === 0, `got ${failBus.published.length}`);
    } finally {
      await failServer.stop();
    }

    console.log('\n── 12. No secret leaks (G2G hash / registration number) ──');
    const allBodies = bodies.join('\n');
    check('G2G subject hash absent from every HTTP response body', !allBodies.includes(G2G_UWIMANA) && !allBodies.includes(G2G_MUKAMANA));
    check('registration number absent from every HTTP response body', !allBodies.includes(REG_ENG_BACHELOR) && !allBodies.includes(REG_NURSING));
    const publishedJson = JSON.stringify(bus.published);
    check('G2G subject hash absent from every published event', !publishedJson.includes(G2G_UWIMANA) && !publishedJson.includes(G2G_MUKAMANA));
    check('registration number absent from every published event', !publishedJson.includes(REG_ENG_BACHELOR) && !publishedJson.includes(REG_NURSING));
  } finally {
    await cleanup(allHashes);
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('ALL DEGREE HEC-SLICE ASSERTIONS PASSED ✓');
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
