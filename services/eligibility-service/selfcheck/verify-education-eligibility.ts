// ══════════════════════════════════════════════════════════════════
// eligibility-service — Live NESA education-eligibility self-check (ADR-005)
//
// Seeds persona identities from the g2g-sandbox catalogue (as identity-
// service writes them, NID hint included), boots the education (NESA) gate
// over @usrp/shared-http with the REAL NesaSdmsGateway pointed at the live
// nesa-sdms simulator (SDMS wire format, ADR-047), and proves through a real
// socket: binding before evaluation (ADR-048 §2.2) including the gap it
// closes, NOT_BOUND / PENDING / REVIEW outcomes, TVET and S3 levels, the RCS
// science bar, faults that are never verdicts, fence 2, and that no persona
// value leaks into a response or an event.
//
//   Run (repo root), Postgres + the g2g-sandbox simulator up:
//   DATABASE_URL=... ADMIN_DATABASE_URL=... PII_ENCRYPTION_KEY=... \
//   NESA_BASE_URL='http://localhost:3101' \
//   pnpm --filter @usrp/eligibility-service selfcheck:education
// ══════════════════════════════════════════════════════════════════

import { randomUUID, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, type EventBus } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { Population, kigaliReferenceDate, type SyntheticCitizen } from '@usrp/g2g-sandbox';
import { AUTH_HEADER, OFFICER_TOKEN, SYSTEM_TOKEN, testVerifier } from './_auth-fixture.js';
import {
  EDUCATION_CHECK_PATH,
  HttpNesaSdmsTransport,
  NesaSdmsGateway,
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
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const APPLICATION_ID = '44444444-4444-4444-8444-444444444444';

// The persona catalogue the running simulator serves (persona data does not
// depend on the population seed; ages are relative to today, Kigali).
const personas = new Population({ seed: 1, size: 0, referenceDate: kigaliReferenceDate(new Date()) });
const P = (id: string): SyntheticCitizen => personas.persona(id);
const indexOf = (id: string): string => P(id).nesa?.studentIndexNumber ?? 'missing';

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

const seededHashes: string[] = [];

/** Seed an applicant_identities row for a persona, as identity-service would write it. */
async function seedPersona(citizen: SyntheticCitizen, identityStatus: 'VERIFIED' | 'PENDING' = 'VERIFIED'): Promise<string> {
  const hash = randomBytes(32).toString('hex');
  seededHashes.push(hash);
  const hint = `${citizen.nid.slice(0, 4)}${citizen.nid.slice(12)}`;
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_system_service`;
    await tx`SELECT set_config('app.encryption_key', ${ENCRYPTION_KEY}, true)`;
    const rows = await tx<{ id: string }[]>`
      INSERT INTO public_core.applicant_identities
        (national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, encrypted_national_id_hint, gender,
         registration_channel, identity_status, nida_verification_request_id,
         nida_verified_at, nida_match_confidence, phone_number_hash)
      VALUES (
        ${hash},
        pgp_sym_encrypt(${`${citizen.surname} ${citizen.forename}`}, current_setting('app.encryption_key')),
        pgp_sym_encrypt(${citizen.dateOfBirth}, current_setting('app.encryption_key')),
        pgp_sym_encrypt(${citizen.address.district}, current_setting('app.encryption_key')),
        pgp_sym_encrypt(${citizen.address.province}, current_setting('app.encryption_key')),
        pgp_sym_encrypt(${hint}, current_setting('app.encryption_key')),
        ${citizen.sex}::public_core.gender,
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

async function cleanup(): Promise<void> {
  if (seededHashes.length > 0) await admin`DELETE FROM public_core.applicant_identities WHERE national_id_hash IN ${admin(seededHashes)}`;
}

/** Build an education route over the real SDMS gateway (optionally a failing fetch or a production env). */
function buildRoute(bus: EventBus, options: { fetchImpl?: typeof fetch; env?: Record<string, string> } = {}) {
  const identityReader = new PgIdentityReader(ENCRYPTION_KEY);
  const nesaGateway = new NesaSdmsGateway({
    transport: new HttpNesaSdmsTransport({ baseUrl: NESA_BASE_URL, timeoutMs: 5000, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }),
    ...(options.env ? { env: options.env } : {}),
  });
  const service = new VerifyNesaEducationService({ identityReader, nesaGateway, eventBus: bus });
  return educationCheckRoute(service, testVerifier);
}

async function main(): Promise<void> {
  const ids: Record<string, string> = {};
  for (const id of ['L-01', 'P-ELIG-UR-SCI70', 'P-UR-SCI-69', 'P-NESA-NAME-MISMATCH', 'P-NESA-HINT-MISMATCH', 'P-NESA-NAME-PARTIAL', 'P-NESA-DIACRITICS', 'P-NESA-UNPUBLISHED', 'P-NESA-MALPRACTICE', 'P-TVET-A2', 'P-S3-ONLY', 'P-NESA-503', 'P-NESA-TRUNCATED']) {
    ids[id] = await seedPersona(P(id));
  }
  const pendingId = await seedPersona(P('P-ELIG-A2'), 'PENDING');
  console.log(`\nSeeded ${String(Object.keys(ids).length + 1)} persona identities — SDMS simulator ${NESA_BASE_URL}`);

  const bus = new InMemoryEventBus();
  const server = await startHttpServer({ serviceName: 'eligibility-education-selfcheck', port: 0, host: '127.0.0.1', routes: [buildRoute(bus)], handleSignals: false });
  const bodies: string[] = [];
  async function callAt(base: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
    const res = await fetch(`${base}${EDUCATION_CHECK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH_HEADER, ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, text, json, headers: res.headers };
  }
  const call = (body: unknown, headers: Record<string, string> = {}) => callAt(server.url, body, headers);
  const ask = (persona: string, category: string, index = indexOf(persona)) =>
    call({ applicantId: ids[persona], applicationId: APPLICATION_ID, category, nesaIndexNumber: index });
  const lastAcademic = () => [...bus.published].reverse().find((e) => e.eventType === 'NESA_VERIFICATION_COMPLETED') as Record<string, unknown> | undefined;
  const lastAudit = () => [...bus.published].reverse().find((e) => e.eventType === 'AUDIT_ENTRY') as Record<string, unknown> | undefined;

  try {
    console.log('\n── 1. Bound A2 record meets GENERAL_ENLISTMENT → EVALUATED ELIGIBLE ──');
    const r1 = await call({ applicantId: ids['L-01'], applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: indexOf('L-01') }, { 'x-correlation-id': CORRELATION_ID });
    const b1 = asRecord(r1.json);
    check('200 EVALUATED ELIGIBLE', r1.status === 200 && b1['status'] === 'EVALUATED' && b1['academicStatus'] === 'ELIGIBLE', `${r1.status} ${r1.text}`);
    check('evaluatedLevel A_LEVEL_A2, agency RDF', b1['evaluatedLevel'] === 'A_LEVEL_A2' && b1['agency'] === 'RDF');
    check('response echoes x-correlation-id', r1.headers.get('x-correlation-id') === CORRELATION_ID);
    check('NESA_VERIFICATION_COMPLETED + AUDIT_ENTRY with the inbound correlationId',
      bus.published.length === 2 && bus.published.every((e) => e.correlationId === CORRELATION_ID));
    check('the audit records the binding per field (all MATCH), no values', JSON.stringify(asRecord(asRecord(lastAudit()?.['metadata'])['binding'])) === JSON.stringify({ name: 'MATCH', dateOfBirth: 'NOT_COMPARED', sex: 'MATCH', nationalIdHint: 'MATCH' }), JSON.stringify(lastAudit()?.['metadata']));

    console.log('\n── 2. THE BINDING GAP (ADR-048 §2.2): someone else\'s valid index → NOT_BOUND, correctable ──');
    const gap = await ask('L-01', 'GENERAL_ENLISTMENT', indexOf('P-ELIG-UR-SCI70'));
    check('422 NESA_RECORD_NOT_BOUND with the citizen-safe copy', gap.status === 422 && asRecord(gap.json)['status'] === 'NESA_RECORD_NOT_BOUND' && String(asRecord(gap.json)['detail']).includes('does not match your identity'), `${gap.status} ${gap.text}`);
    check('...naming nobody', !gap.text.includes(P('P-ELIG-UR-SCI70').surname) && !gap.text.includes(P('L-01').surname));
    const gapEvent = lastAcademic();
    check('academic verdict is PENDING, never INELIGIBLE', gapEvent?.['academicStatus'] === 'PENDING', String(gapEvent?.['academicStatus']));
    check('failureCode NESA_RECORD_NOT_BOUND', asRecord(gapEvent?.['eligibilityResult'])['failureCode'] === 'NESA_RECORD_NOT_BOUND');
    check('audit action NESA_RECORD_NOT_BOUND', lastAudit()?.['action'] === 'NESA_RECORD_NOT_BOUND');

    console.log('\n── 3. Binding personas ──');
    const nm = await ask('P-NESA-NAME-MISMATCH', 'GENERAL_ENLISTMENT');
    check('name mismatch → 422 NOT_BOUND', nm.status === 422 && asRecord(nm.json)['status'] === 'NESA_RECORD_NOT_BOUND', `${nm.status} ${nm.text}`);
    const hm = await ask('P-NESA-HINT-MISMATCH', 'GENERAL_ENLISTMENT');
    check('NID-hint mismatch → 422 NOT_BOUND', hm.status === 422, `${hm.status} ${hm.text}`);
    check('...the audit names the field, not the value', asRecord(asRecord(lastAudit()?.['metadata'])['binding'])['nationalIdHint'] === 'MISMATCH');
    const np = await ask('P-NESA-NAME-PARTIAL', 'GENERAL_ENLISTMENT');
    check('partial name → 202 REVIEW [NAME_PARTIAL]', np.status === 202 && JSON.stringify(asRecord(np.json)['reasons']) === '["NAME_PARTIAL"]', `${np.status} ${np.text}`);
    const dia = await ask('P-NESA-DIACRITICS', 'GENERAL_ENLISTMENT');
    check('diacritics / order / case → still BOUND and EVALUATED', dia.status === 200 && asRecord(dia.json)['academicStatus'] === 'ELIGIBLE', `${dia.status} ${dia.text}`);

    console.log('\n── 4. Real-world NESA states ──');
    const un = await ask('P-NESA-UNPUBLISHED', 'GENERAL_ENLISTMENT');
    check('published:false → 202 PENDING, never ineligible', un.status === 202 && asRecord(un.json)['status'] === 'NESA_RESULTS_PENDING' && lastAcademic()?.['academicStatus'] === 'PENDING', `${un.status} ${un.text}`);
    const mp = await ask('P-NESA-MALPRACTICE', 'GENERAL_ENLISTMENT');
    check('malpractice → 202 REVIEW [MALPRACTICE], never automatic', mp.status === 202 && JSON.stringify(asRecord(mp.json)['reasons']) === '["MALPRACTICE"]', `${mp.status} ${mp.text}`);
    const tv = await ask('P-TVET-A2', 'RESERVE_FORCE_ALEVEL');
    check('TVET at A2 counts as A2 (default) → ELIGIBLE', tv.status === 200 && asRecord(tv.json)['academicStatus'] === 'ELIGIBLE', `${tv.status} ${tv.text}`);
    const s3a = await ask('P-S3-ONLY', 'GENERAL_ENLISTMENT');
    check('S3 only, RDF regular (min S3) → ELIGIBLE', s3a.status === 200 && asRecord(s3a.json)['academicStatus'] === 'ELIGIBLE', `${s3a.status} ${s3a.text}`);
    const s3b = await ask('P-S3-ONLY', 'BASIC_POLICE_COURSE');
    check('S3 only, RNP Basic (A2) → INELIGIBLE', s3b.status === 200 && asRecord(s3b.json)['academicStatus'] === 'INELIGIBLE', `${s3b.status} ${s3b.text}`);
    const sci = await ask('P-ELIG-UR-SCI70', 'OFFICER_FOUR_YEAR_UR');
    check('RCS 4-year, weightedPercent 74 ≥ 70 → ELIGIBLE', sci.status === 200 && asRecord(sci.json)['academicStatus'] === 'ELIGIBLE', `${sci.status} ${sci.text}`);
    const low = await ask('P-UR-SCI-69', 'OFFICER_FOUR_YEAR_UR');
    check('RCS 4-year, weightedPercent 69 < 70 → INELIGIBLE', low.status === 200 && asRecord(low.json)['academicStatus'] === 'INELIGIBLE', `${low.status} ${low.text}`);

    console.log('\n── 5. Unknown index, wrong path, preconditions ──');
    const before = bus.published.length;
    const r4 = await ask('L-01', 'GENERAL_ENLISTMENT', '990000ZZZ9992020');
    check('unknown index → 422 NESA_RECORD_NOT_FOUND', r4.status === 422 && asRecord(r4.json)['status'] === 'NESA_RECORD_NOT_FOUND', `${r4.status} ${r4.text}`);
    check('...with INELIGIBLE events', bus.published.slice(before).some((e) => e.eventType === 'NESA_VERIFICATION_COMPLETED' && e.academicStatus === 'INELIGIBLE'));
    const r5 = await ask('L-01', 'CADET_OFFICER');
    check('degree category → 409 NESA_NOT_APPLICABLE', r5.status === 409, `${r5.status} ${r5.text}`);
    const before6 = bus.published.length;
    const r6 = await call({ applicantId: pendingId, applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: indexOf('P-ELIG-A2') });
    check('unverified identity → 409, no event', r6.status === 409 && bus.published.length === before6, `${r6.status} ${r6.text}`);
    const r7 = await call({ applicantId: randomUUID(), applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: indexOf('L-01') });
    check('unknown applicant → 404', r7.status === 404, `${r7.status}`);

    console.log('\n── 6. Input validation and auth ──');
    check('bad applicantId → 400', (await call({ applicantId: 'nope', applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: indexOf('L-01') })).status === 400);
    check('bad category → 400', (await ask('L-01', 'NOPE')).status === 400);
    check('bad index → 400', (await ask('L-01', 'GENERAL_ENLISTMENT', '!!')).status === 400);
    check('invalid token → 401', (await call({ applicantId: ids['L-01'], applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: indexOf('L-01') }, { authorization: 'Bearer not-a-valid-token' })).status === 401);
    check('officer token on a system route → 403', (await call({ applicantId: ids['L-01'], applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: indexOf('L-01') }, { authorization: `Bearer ${OFFICER_TOKEN}` })).status === 403);

    console.log('\n── 7. Registry faults are never verdicts ──');
    for (const id of ['P-NESA-503', 'P-NESA-TRUNCATED']) {
      const before7 = bus.published.length;
      const r = await ask(id, 'GENERAL_ENLISTMENT');
      check(`${id} → 503 NESA_UNAVAILABLE, no event`, r.status === 503 && asRecord(r.json)['error'] === 'NESA_UNAVAILABLE' && bus.published.length === before7, `${r.status} ${r.text}`);
    }
    for (const [label, options] of [
      ['NESA unreachable', { fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch }],
      ['FENCE 2: production refuses the simulator answer', { env: { NODE_ENV: 'production' } }],
    ] as const) {
      const failBus = new InMemoryEventBus();
      const failServer = await startHttpServer({ serviceName: 'eligibility-education-selfcheck-fail', port: 0, host: '127.0.0.1', routes: [buildRoute(failBus, options)], handleSignals: false });
      try {
        const r = await callAt(failServer.url, { applicantId: ids['L-01'], applicationId: APPLICATION_ID, category: 'GENERAL_ENLISTMENT', nesaIndexNumber: indexOf('L-01') }, { authorization: `Bearer ${SYSTEM_TOKEN}` });
        check(`${label} → 503, no event`, r.status === 503 && failBus.published.length === 0, `${r.status} ${r.text}`);
      } finally {
        await failServer.stop();
      }
    }

    console.log('\n── 8. No PII leaks (names, DOB, school, NID hint) ──');
    const everything = `${bodies.join('\n')}\n${JSON.stringify(bus.published)}`;
    for (const id of Object.keys(ids)) {
      const c = P(id);
      if (everything.includes(c.surname) || everything.includes(c.dateOfBirth) || everything.includes(c.nesa?.attendedSchool ?? '\u0000') || everything.includes(c.nesa?.studentNationalIdHint ?? '\u0000')) {
        check(`no value of ${id} in any body or event`, false);
      }
    }
    check('no persona name, DOB, school or hint in any body or event', true);
  } finally {
    await cleanup();
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
