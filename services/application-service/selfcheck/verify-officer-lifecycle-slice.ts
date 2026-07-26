// ══════════════════════════════════════════════════════════════════
// application-service — Live officer-lifecycle self-check (Slice 4)
//
// Proves the human tail of the green digital lane end-to-end against live
// infrastructure: boots the real service (all routes) over @usrp/shared-http on
// an ephemeral port, mints Ed25519 OFFICER tokens with UUID subjects, and drives
// the three write endpoints through a real TCP socket.
//
// Load-bearing claims:
//   • medical-review → final-decision → accept carries one application
//     PHYSICAL_TEST_COMPLETE → MEDICAL_REVIEW → FINAL_SHORTLIST → ACCEPTED,
//     each stamping its reviewer/decider column + appending status-history.
//   • the writes run AS THE OFFICER DB ROLE — an RDF officer acting on an RNP
//     application gets NOT_FOUND (cross-agency isolation, DB-enforced).
//   • idempotent (NO_CHANGE), hold-safe (NOT_APPLICABLE), fail-closed rejects
//     (UNFIT / final REJECT → REJECTED), 401 unauthenticated, 403 system token.
//   • every genuine transition emits exactly one AUDIT_ENTRY (performedBy =
//     officer subjectId); no-ops emit nothing; responses carry no PII.
//   • accept stamps the platform-wide accept-lock on the citizen's shared
//     identity row (ADR-014, as the officer's own DB role); a sibling agency's
//     accept of the same citizen → 409 CROSS_AGENCY_LOCKED naming the holder,
//     nothing written, no audit — and raced concurrent accepts serialize on
//     the identity row so exactly ONE agency wins.
//
//   Run (repo root), with the live Tier-1 stack up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/application-service/selfcheck/verify-officer-lifecycle-slice.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import {
  createApplicationService,
  loadApplicationConfig,
  submitApplicationRoute,
  listApplicationsRoute,
  officerTransitionRoutes,
  MEDICAL_REVIEW_PATH,
  FINAL_DECISION_PATH,
  ACCEPT_PATH,
} from '../src/index.js';

// ── In-test issuer key: set the verify public key BEFORE loading config ──
const AUTH_KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(AUTH_KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// Deterministic fixtures. Officer subjects are UUIDs — they land in the
// medical_reviewed_by_id / final_decision_by_id UUID columns (aligns with the
// future token issuer, which will mint officer ids as UUIDs).
// Applicant A travels the RDF lanes AND holds the accept-lock scenario; the
// certificate-mode lanes (RNP/RCS) get their OWN citizens — under ADR-014 one
// citizen can only ever be accepted once platform-wide, so each lane that ends
// in ACCEPTED needs a distinct identity. Applicant D exists only for the
// concurrent-accept race.
const APPLICANT_ID = '4d000000-0000-4000-8000-000000000001';
const APPLICANT_B = '4d000000-0000-4000-8000-000000000002'; // RNP cert lane
const APPLICANT_C = '4d000000-0000-4000-8000-000000000003'; // RCS cert lanes
const APPLICANT_D = '4d000000-0000-4000-8000-000000000004'; // accept race
const ALL_APPLICANTS = [APPLICANT_ID, APPLICANT_B, APPLICANT_C, APPLICANT_D];
const NID_HASH = '4d4d4d4d'.repeat(8); // 64 hex
const NID_HASH_B = '4e4e4e4e'.repeat(8);
const NID_HASH_C = '4f4f4f4f'.repeat(8);
const NID_HASH_D = '5a5a5a5a'.repeat(8);
const RDF_CAMPAIGN = '4d000000-0000-4000-8000-0000000000c1';
const RNP_CAMPAIGN = '4d000000-0000-4000-8000-0000000000c2';
const RCS_CAMPAIGN = '4d000000-0000-4000-8000-0000000000c3';
const RDF_OFFICER_ID = '4d000000-0000-4000-8000-00000000ff01';
const RNP_OFFICER_ID = '4d000000-0000-4000-8000-00000000ff02';
const RCS_OFFICER_ID = '4d000000-0000-4000-8000-00000000ff03';

// One RDF app per scenario, plus RNP/RCS apps for the cross-agency probe and
// the CERTIFICATE-mode lanes (ADR-013). Lock-slice apps (ADR-014): a second
// RNP application for the already-accepted applicant A, and a matched pair
// for applicant D raced from two agencies at once.
const APP_HAPPY = '4d000000-0000-4000-8000-00000000a001'; // full path → ACCEPTED
const APP_UNFIT = '4d000000-0000-4000-8000-00000000a002'; // UNFIT → REJECTED
const APP_FINAL = '4d000000-0000-4000-8000-00000000a003'; // seeded at MEDICAL_REVIEW; final REJECT
const APP_HOLD = '4d000000-0000-4000-8000-00000000a004'; // accept out of order → hold
const RNP_APP = '4d000000-0000-4000-8000-00000000b001'; // cross-agency probe, then cert lane → ACCEPTED
const RCS_APP = '4d000000-0000-4000-8000-00000000b002'; // cert lane → ACCEPTED
const RCS_APP_REJ = '4d000000-0000-4000-8000-00000000b003'; // CERT_REJECTED → REJECTED
const RNP_LOCK_APP = '4d000000-0000-4000-8000-00000000d001'; // applicant A in RNP → 409 locked
const RACE_RNP_APP = '4d000000-0000-4000-8000-00000000d002'; // applicant D, raced
const RACE_RCS_APP = '4d000000-0000-4000-8000-00000000d003'; // applicant D, raced

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function mint(
  kind: 'officer' | 'system',
  opts: { agency?: 'RDF' | 'RNP' | 'RCS'; sub?: string } = {},
): string {
  const base = {
    v: 1 as const,
    iss: 'usrp',
    aud: 'usrp-services',
    sub: opts.sub ?? `selfcheck-${kind}`,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer'
      ? { ...base, kind, agency: opts.agency ?? 'RDF', roles: [] }
      : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const schema of ['rdf_ops', 'rnp_ops', 'rcs_ops'] as const) {
      await tx`
        DELETE FROM ${tx(schema)}.application_status_history
        WHERE application_id IN (SELECT id FROM ${tx(schema)}.applications WHERE applicant_id IN ${tx(ALL_APPLICANTS)})`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE applicant_id IN ${tx(ALL_APPLICANTS)}`;
    }
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([RDF_CAMPAIGN, RNP_CAMPAIGN, RCS_CAMPAIGN])}`;
    // Deleting the identity rows also clears any accept-lock stamped this run.
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx(ALL_APPLICANTS)}`;
  });
}

async function seed(): Promise<void> {
  // Four citizens (ADR-014: one acceptance per citizen platform-wide, so every
  // lane that ends in ACCEPTED needs its own identity row).
  const identities: ReadonlyArray<[string, string]> = [
    [APPLICANT_ID, NID_HASH],
    [APPLICANT_B, NID_HASH_B],
    [APPLICANT_C, NID_HASH_C],
    [APPLICANT_D, NID_HASH_D],
  ];
  for (const [id, hash] of identities) {
    await admin`
      INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, gender,
         registration_channel, identity_status)
      VALUES (${id}, ${hash}, 'x', 'x', 'x', 'x', 'MALE', 'WEB',
              'VERIFIED'::public_core.identity_verification_status)`;
  }
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${RDF_CAMPAIGN}, 'Officer-lifecycle RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
      (${RNP_CAMPAIGN}, 'Officer-lifecycle RNP', 'RNP', 'REGISTRATION_OPEN', '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
      (${RCS_CAMPAIGN}, 'Officer-lifecycle RCS', 'RCS', 'REGISTRATION_OPEN', '["GENERAL_ENLISTEE"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;

  // Seed each RDF scenario app at its starting status; the RNP app mirrors the
  // happy start for the cross-agency probe. Status seeded directly — this slice
  // proves the officer transitions, not the upstream pipeline that reaches them.
  const rdf: ReadonlyArray<[string, string, string]> = [
    [APP_HAPPY, 'RDF-96001', 'PHYSICAL_TEST_COMPLETE'],
    [APP_UNFIT, 'RDF-96002', 'PHYSICAL_TEST_COMPLETE'],
    [APP_FINAL, 'RDF-96003', 'MEDICAL_REVIEW'],
    [APP_HOLD, 'RDF-96004', 'PHYSICAL_TEST_COMPLETE'],
  ];
  for (const [id, code, status] of rdf) {
    await admin`
      INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
      VALUES (${id}, ${code}, ${APPLICANT_ID}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT',
              ${status}::rdf_ops.application_status)`;
  }
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RNP_APP}, 'RNP-96001', ${APPLICANT_B}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
            'PHYSICAL_TEST_COMPLETE'::rnp_ops.application_status)`;
  // CERTIFICATE-mode lanes (ADR-013): both RCS apps start where medical fires.
  const rcs: ReadonlyArray<[string, string]> = [
    [RCS_APP, 'RCS-96001'],
    [RCS_APP_REJ, 'RCS-96002'],
  ];
  for (const [id, code] of rcs) {
    await admin`
      INSERT INTO rcs_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
      VALUES (${id}, ${code}, ${APPLICANT_C}, ${RCS_CAMPAIGN}, 'GENERAL_ENLISTEE',
              'PHYSICAL_TEST_COMPLETE'::rcs_ops.application_status)`;
  }

  // Accept-lock lanes (ADR-014), all seeded at FINAL_SHORTLIST — shortlisting
  // the same citizen twice is legitimate; only ACCEPT contends for the lock.
  // Applicant A will already be RDF-accepted when RNP tries; applicant D is
  // shortlisted by RNP and RCS and raced.
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES
      (${RNP_LOCK_APP}, 'RNP-96002', ${APPLICANT_ID}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
       'FINAL_SHORTLIST'::rnp_ops.application_status),
      (${RACE_RNP_APP}, 'RNP-96003', ${APPLICANT_D}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
       'FINAL_SHORTLIST'::rnp_ops.application_status)`;
  await admin`
    INSERT INTO rcs_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RACE_RCS_APP}, 'RCS-96003', ${APPLICANT_D}, ${RCS_CAMPAIGN}, 'GENERAL_ENLISTEE',
            'FINAL_SHORTLIST'::rcs_ops.application_status)`;
}

/** Read one application row (as superuser — sees all agencies) for assertions. */
async function appRow(schema: 'rdf_ops' | 'rnp_ops', id: string): Promise<Record<string, unknown>> {
  const rows = await admin<Record<string, unknown>[]>`
    SELECT status, medical_reviewed_by_id, medical_reviewed_at, medical_fitness_status,
           final_decision_by_id, final_decision_at, final_decision_notes
    FROM ${admin(schema)}.applications WHERE id = ${id}`;
  return rows[0] ?? {};
}

/** Status-only read — safe for any ops schema (board columns are RDF-only). */
async function statusOf(schema: 'rdf_ops' | 'rnp_ops' | 'rcs_ops', id: string): Promise<string> {
  const rows = await admin<{ status: string }[]>`
    SELECT status FROM ${admin(schema)}.applications WHERE id = ${id}`;
  return rows[0]?.status ?? '(absent)';
}

/** Certificate-mode read (rnp_ops + rcs_ops carry the mirrored cert columns). */
async function certRow(schema: 'rnp_ops' | 'rcs_ops', id: string): Promise<Record<string, unknown>> {
  const rows = await admin<Record<string, unknown>[]>`
    SELECT status, medical_cert_verified, medical_cert_verified_at, medical_cert_physician_name
    FROM ${admin(schema)}.applications WHERE id = ${id}`;
  return rows[0] ?? {};
}

async function historyCount(schema: 'rdf_ops' | 'rnp_ops' | 'rcs_ops'): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${admin(schema)}.application_status_history
    WHERE application_id IN (SELECT id FROM ${admin(schema)}.applications WHERE applicant_id IN ${admin(ALL_APPLICANTS)})`;
  return rows[0]?.n ?? -1;
}

/** Accept-lock columns on the shared identity row (ADR-014). */
async function lockOf(applicantId: string): Promise<Record<string, unknown>> {
  const rows = await admin<Record<string, unknown>[]>`
    SELECT cross_agency_locked_at, cross_agency_locked_by_agency, cross_agency_lock_reason
    FROM public_core.applicant_identities WHERE id = ${applicantId}`;
  return rows[0] ?? {};
}

async function main(): Promise<void> {
  const config = loadApplicationConfig();
  const bus = new InMemoryEventBus();
  const service = createApplicationService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  await cleanup();
  await seed();

  const server = await startHttpServer({
    serviceName: 'application-service-officer-lifecycle-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [
      submitApplicationRoute(service.submit, verify),
      listApplicationsRoute(service.list, verify),
      ...officerTransitionRoutes(service.officerTransitions, verify),
    ],
    handleSignals: false,
  });
  const base = server.url;
  console.log(`\nServer listening at ${base}`);

  const asRecord = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

  async function post(
    path: string,
    body: unknown,
    token?: string,
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json: asRecord(json) };
  }

  const rdfOfficer = mint('officer', { agency: 'RDF', sub: RDF_OFFICER_ID });
  const auditEntries = (): Record<string, unknown>[] =>
    bus.published.filter((e) => asRecord(e)['eventType'] === 'AUDIT_ENTRY').map(asRecord);

  try {
    // ── 1. Happy path: PHYSICAL_TEST_COMPLETE → … → ACCEPTED ──
    console.log('\n── 1. Green lane to ACCEPTED (officer writes as officer DB role) ──');
    const med = await post(MEDICAL_REVIEW_PATH, { applicationId: APP_HAPPY, fitnessStatus: 'FIT' }, rdfOfficer);
    check('medical-review FIT → 200 APPLIED', med.status === 200 && med.json['status'] === 'APPLIED', med.text);
    check('  transition PHYSICAL_TEST_COMPLETE → MEDICAL_REVIEW',
      med.json['fromStatus'] === 'PHYSICAL_TEST_COMPLETE' && med.json['toStatus'] === 'MEDICAL_REVIEW');
    let row = await appRow('rdf_ops', APP_HAPPY);
    check('  DB status = MEDICAL_REVIEW', row['status'] === 'MEDICAL_REVIEW', String(row['status']));
    check('  medical_reviewed_by_id = officer UUID', row['medical_reviewed_by_id'] === RDF_OFFICER_ID, String(row['medical_reviewed_by_id']));
    check('  medical_fitness_status = FIT', row['medical_fitness_status'] === 'FIT', String(row['medical_fitness_status']));
    check('  medical_reviewed_at stamped', row['medical_reviewed_at'] != null);

    const fin = await post(FINAL_DECISION_PATH, { applicationId: APP_HAPPY, decision: 'SHORTLIST', notes: 'Strong candidate' }, rdfOfficer);
    check('final-decision SHORTLIST → 200 APPLIED', fin.status === 200 && fin.json['status'] === 'APPLIED', fin.text);
    check('  transition MEDICAL_REVIEW → FINAL_SHORTLIST',
      fin.json['fromStatus'] === 'MEDICAL_REVIEW' && fin.json['toStatus'] === 'FINAL_SHORTLIST');
    row = await appRow('rdf_ops', APP_HAPPY);
    check('  final_decision_by_id = officer UUID', row['final_decision_by_id'] === RDF_OFFICER_ID);
    check('  final_decision_notes stored', row['final_decision_notes'] === 'Strong candidate');

    const acc = await post(ACCEPT_PATH, { applicationId: APP_HAPPY }, rdfOfficer);
    check('accept → 200 APPLIED', acc.status === 200 && acc.json['status'] === 'APPLIED', acc.text);
    check('  transition FINAL_SHORTLIST → ACCEPTED',
      acc.json['fromStatus'] === 'FINAL_SHORTLIST' && acc.json['toStatus'] === 'ACCEPTED');
    row = await appRow('rdf_ops', APP_HAPPY);
    check('  DB status = ACCEPTED', row['status'] === 'ACCEPTED', String(row['status']));

    // ── 2. Idempotent re-apply → NO_CHANGE (no new write) ──
    console.log('\n── 2. Idempotent re-apply ──');
    const histBefore = await historyCount('rdf_ops');
    const auditBefore = auditEntries().length;
    const again = await post(ACCEPT_PATH, { applicationId: APP_HAPPY }, rdfOfficer);
    check('accept on ACCEPTED → 200 NO_CHANGE', again.status === 200 && again.json['status'] === 'NO_CHANGE', again.text);
    check('  currentStatus = ACCEPTED', again.json['currentStatus'] === 'ACCEPTED');
    check('  no history appended by a no-op', (await historyCount('rdf_ops')) === histBefore);
    check('  no audit emitted by a no-op', auditEntries().length === auditBefore);

    // ── 3. Fail-closed rejects ──
    console.log('\n── 3. UNFIT and final-REJECT both drive to REJECTED ──');
    const unfit = await post(MEDICAL_REVIEW_PATH, { applicationId: APP_UNFIT, fitnessStatus: 'UNFIT' }, rdfOfficer);
    check('medical-review UNFIT → 200 APPLIED → REJECTED', unfit.status === 200 && unfit.json['toStatus'] === 'REJECTED', unfit.text);
    row = await appRow('rdf_ops', APP_UNFIT);
    check('  DB status = REJECTED, fitness = UNFIT', row['status'] === 'REJECTED' && row['medical_fitness_status'] === 'UNFIT');

    const finRej = await post(FINAL_DECISION_PATH, { applicationId: APP_FINAL, decision: 'REJECT', notes: 'Failed final vetting' }, rdfOfficer);
    check('final-decision REJECT (from MEDICAL_REVIEW) → REJECTED', finRej.status === 200 && finRej.json['toStatus'] === 'REJECTED', finRej.text);
    check('  DB status = REJECTED', (await appRow('rdf_ops', APP_FINAL))['status'] === 'REJECTED');

    // ── 4. Hold-safe: acting out of order ──
    console.log('\n── 4. Hold-safe (wrong prior status) ──');
    const hold = await post(ACCEPT_PATH, { applicationId: APP_HOLD }, rdfOfficer);
    check('accept while PHYSICAL_TEST_COMPLETE → 409 NOT_APPLICABLE', hold.status === 409 && hold.json['status'] === 'NOT_APPLICABLE', hold.text);
    check('  currentStatus reported = PHYSICAL_TEST_COMPLETE', hold.json['currentStatus'] === 'PHYSICAL_TEST_COMPLETE');
    check('  row untouched (still PHYSICAL_TEST_COMPLETE)', (await appRow('rdf_ops', APP_HOLD))['status'] === 'PHYSICAL_TEST_COMPLETE');

    // ── 5. Cross-agency isolation (DB-enforced) ──
    console.log('\n── 5. Cross-agency officer → NOT_FOUND ──');
    const cross = await post(MEDICAL_REVIEW_PATH, { applicationId: RNP_APP, fitnessStatus: 'FIT' }, rdfOfficer);
    check('RDF officer acting on an RNP app → 404 NOT_FOUND', cross.status === 404 && cross.json['status'] === 'NOT_FOUND', cross.text);
    check('  RNP app untouched (still PHYSICAL_TEST_COMPLETE)', (await statusOf('rnp_ops', RNP_APP)) === 'PHYSICAL_TEST_COMPLETE');
    // And an RNP officer likewise cannot reach into rdf_ops.
    const crossBack = await post(ACCEPT_PATH, { applicationId: APP_HAPPY }, mint('officer', { agency: 'RNP', sub: RNP_OFFICER_ID }));
    check('RNP officer acting on an RDF app → 404 NOT_FOUND', crossBack.status === 404 && crossBack.json['status'] === 'NOT_FOUND', crossBack.text);

    // Medical review is mode-split (ADR-013): RNP/RCS verify a physician
    // CERTIFICATE, so a board-mode body (fitnessStatus) from an RNP officer
    // is a caller error — 422, and the app stays untouched, proving the mode
    // guard fires before any write. (Retires the Slice-4 501.)
    const rnpMed = await post(MEDICAL_REVIEW_PATH, { applicationId: RNP_APP, fitnessStatus: 'FIT' }, mint('officer', { agency: 'RNP', sub: RNP_OFFICER_ID }));
    check('RNP officer sending board-mode body → 422 INVALID_MEDICAL_INPUT', rnpMed.status === 422 && rnpMed.json['status'] === 'INVALID_MEDICAL_INPUT', rnpMed.text);
    check('  RNP app untouched by the invalid-mode call', (await statusOf('rnp_ops', RNP_APP)) === 'PHYSICAL_TEST_COMPLETE');

    // ── 6. AuthN / AuthZ ──
    console.log('\n── 6. Auth gate ──');
    check('no token → 401', (await post(MEDICAL_REVIEW_PATH, { applicationId: APP_HAPPY, fitnessStatus: 'FIT' })).status === 401);
    check('system token → 403', (await post(MEDICAL_REVIEW_PATH, { applicationId: APP_HAPPY, fitnessStatus: 'FIT' }, mint('system'))).status === 403);
    check('bad applicationId → 400', (await post(ACCEPT_PATH, { applicationId: 'not-a-uuid' }, rdfOfficer)).status === 400);
    check('bad fitnessStatus → 400', (await post(MEDICAL_REVIEW_PATH, { applicationId: APP_HOLD, fitnessStatus: 'MAYBE' }, rdfOfficer)).status === 400);

    // ── 7. Audit trail + append-only history: one entry per genuine transition ──
    console.log('\n── 7. Audit + append-only history accounting ──');
    // Genuine transitions this run: happy(3) + unfit(1) + finalReject(1) = 5.
    const entries = auditEntries();
    check('exactly 5 AUDIT_ENTRY events (one per genuine transition)', entries.length === 5, `got ${entries.length}`);
    check('all audit entries performedBy the officer UUID', entries.every((e) => e['performedBy'] === RDF_OFFICER_ID));
    check('all audit entries are APPLICATION scoped', entries.every((e) => e['entityType'] === 'APPLICATION'));
    check('reject transitions use action APPLICATION_REJECTED',
      entries.filter((e) => e['newStatus'] === 'REJECTED').every((e) => e['action'] === 'APPLICATION_REJECTED'));
    check('advance transitions use action APPLICATION_STATUS_ADVANCED',
      entries.filter((e) => e['newStatus'] !== 'REJECTED').every((e) => e['action'] === 'APPLICATION_STATUS_ADVANCED'));
    check('5 status-history rows appended in rdf_ops', (await historyCount('rdf_ops')) === 5, String(await historyCount('rdf_ops')));
    check('0 status-history rows in rnp_ops (cross-agency never wrote)', (await historyCount('rnp_ops')) === 0);

    // ── 8. No PII in any response ──
    console.log('\n── 8. No PII in responses ──');
    const allResponses = [med, fin, acc, again, unfit, finRej, hold, cross].map((r) => r.text).join('|');
    check('no national_id_hash in any response body', !allResponses.includes(NID_HASH));

    // ── 9. CERTIFICATE mode (ADR-013): RNP + RCS travel the full funnel ──
    console.log('\n── 9. Certificate mode: RNP + RCS reach ACCEPTED ──');
    const rnpOfficer = mint('officer', { agency: 'RNP', sub: RNP_OFFICER_ID });
    const rcsOfficer = mint('officer', { agency: 'RCS', sub: RCS_OFFICER_ID });

    // Input guards fire BEFORE any write (app still at PHYSICAL_TEST_COMPLETE).
    const noName = await post(MEDICAL_REVIEW_PATH, { applicationId: RNP_APP, certVerdict: 'CERT_VERIFIED' }, rnpOfficer);
    check('CERT_VERIFIED without physicianName → 422', noName.status === 422 && noName.json['status'] === 'INVALID_MEDICAL_INPUT', noName.text);
    const nameOnReject = await post(MEDICAL_REVIEW_PATH, { applicationId: RNP_APP, certVerdict: 'CERT_REJECTED', physicianName: 'Dr X' }, rnpOfficer);
    check('physicianName alongside CERT_REJECTED → 422', nameOnReject.status === 422, nameOnReject.text);
    check('  RNP app untouched by the invalid inputs', (await statusOf('rnp_ops', RNP_APP)) === 'PHYSICAL_TEST_COMPLETE');

    // RNP: cert-verify → MEDICAL_REVIEW → SHORTLIST → ACCEPTED (as RNP officer role).
    const PHYSICIAN = 'Dr. Mukamana Chantal — Kacyiru Hospital';
    const rnpVerify = await post(MEDICAL_REVIEW_PATH, { applicationId: RNP_APP, certVerdict: 'CERT_VERIFIED', physicianName: PHYSICIAN }, rnpOfficer);
    check('RNP cert-verify APPLIED → MEDICAL_REVIEW', rnpVerify.status === 200 && rnpVerify.json['toStatus'] === 'MEDICAL_REVIEW', rnpVerify.text);
    const rnpRow = await certRow('rnp_ops', RNP_APP);
    check('  rnp_ops cert columns stamped (0012 landing)',
      rnpRow['medical_cert_verified'] === true && rnpRow['medical_cert_verified_at'] !== null && rnpRow['medical_cert_physician_name'] === PHYSICIAN);
    const rnpFin = await post(FINAL_DECISION_PATH, { applicationId: RNP_APP, decision: 'SHORTLIST' }, rnpOfficer);
    const rnpAcc = await post(ACCEPT_PATH, { applicationId: RNP_APP }, rnpOfficer);
    check('RNP reaches ACCEPTED (the 501 dead-end is retired)',
      rnpFin.status === 200 && rnpAcc.status === 200 && (await statusOf('rnp_ops', RNP_APP)) === 'ACCEPTED');

    // RCS: same certificate lane, plus idempotent re-apply before advancing.
    const rcsVerify = await post(MEDICAL_REVIEW_PATH, { applicationId: RCS_APP, certVerdict: 'CERT_VERIFIED', physicianName: 'Dr. Nkurunziza J.' }, rcsOfficer);
    check('RCS cert-verify APPLIED → MEDICAL_REVIEW', rcsVerify.status === 200 && rcsVerify.json['toStatus'] === 'MEDICAL_REVIEW', rcsVerify.text);
    const rcsAgain = await post(MEDICAL_REVIEW_PATH, { applicationId: RCS_APP, certVerdict: 'CERT_VERIFIED', physicianName: 'Dr. Nkurunziza J.' }, rcsOfficer);
    check('RCS cert-verify re-apply → NO_CHANGE (idempotent)', rcsAgain.status === 200 && rcsAgain.json['status'] === 'NO_CHANGE', rcsAgain.text);
    const rcsFin = await post(FINAL_DECISION_PATH, { applicationId: RCS_APP, decision: 'SHORTLIST' }, rcsOfficer);
    const rcsAcc = await post(ACCEPT_PATH, { applicationId: RCS_APP }, rcsOfficer);
    check('RCS reaches ACCEPTED', rcsFin.status === 200 && rcsAcc.status === 200 && (await statusOf('rcs_ops', RCS_APP)) === 'ACCEPTED');

    // CERT_REJECTED: REJECTED + history are the record; cert columns stay honest.
    const rcsRej = await post(MEDICAL_REVIEW_PATH, { applicationId: RCS_APP_REJ, certVerdict: 'CERT_REJECTED' }, rcsOfficer);
    check('CERT_REJECTED → REJECTED', rcsRej.status === 200 && rcsRej.json['toStatus'] === 'REJECTED', rcsRej.text);
    const rejRow = await certRow('rcs_ops', RCS_APP_REJ);
    check('  cert columns untouched on rejection (false / null / null)',
      rejRow['medical_cert_verified'] === false && rejRow['medical_cert_verified_at'] === null && rejRow['medical_cert_physician_name'] === null);

    // Accounting: RNP 3 transitions; RCS 3 + 1 rejection. History performed_by
    // carries the verifying officer (cert columns have no *_by_id — RCS parity).
    check('3 history rows in rnp_ops', (await historyCount('rnp_ops')) === 3, String(await historyCount('rnp_ops')));
    check('4 history rows in rcs_ops', (await historyCount('rcs_ops')) === 4, String(await historyCount('rcs_ops')));
    const rnpHistory = await admin<{ performed_by: string }[]>`
      SELECT performed_by FROM rnp_ops.application_status_history
      WHERE application_id = ${RNP_APP} ORDER BY performed_at`;
    check('rnp history performed_by = RNP officer UUID', rnpHistory.every((r) => r.performed_by === RNP_OFFICER_ID));

    // The physician name reaches the DB column and NOWHERE else: not in the
    // audit stream, not in any HTTP response.
    const certAudits = auditEntries().filter((e) => asRecord(e['metadata'])['mode'] === 'CERTIFICATE');
    check('certificate audits emitted for each genuine transition', certAudits.length === 3, String(certAudits.length));
    check('physician name never on the event bus', !JSON.stringify(bus.published).includes('Mukamana'));
    const certResponses = [noName, nameOnReject, rnpVerify, rnpFin, rnpAcc, rcsVerify, rcsAgain, rcsFin, rcsAcc, rcsRej].map((r) => r.text).join('|');
    check('no national_id_hash in certificate-mode responses', !certResponses.includes(NID_HASH));
    check('physician name not echoed in responses', !certResponses.includes('Mukamana'));

    // ── 10. Cross-agency accept-lock (ADR-014): one citizen, one acceptance ──
    console.log('\n── 10. Accept-lock: one acceptance per citizen, platform-wide ──');
    // Every accept above stamped the citizen's shared identity row — as the
    // accepting officer's OWN DB role (no system escalation).
    const lockA = await lockOf(APPLICANT_ID);
    check('RDF accept stamped the lock on applicant A',
      lockA['cross_agency_locked_by_agency'] === 'RDF' && lockA['cross_agency_locked_at'] !== null && lockA['cross_agency_lock_reason'] === 'ACCEPTED',
      JSON.stringify(lockA));
    check('RNP accept stamped applicant B', (await lockOf(APPLICANT_B))['cross_agency_locked_by_agency'] === 'RNP');
    check('RCS accept stamped applicant C', (await lockOf(APPLICANT_C))['cross_agency_locked_by_agency'] === 'RCS');

    // Applicant A is already RDF-accepted; RNP legitimately shortlisted the
    // same citizen (shortlist never contends) — but the ACCEPT must refuse,
    // name the holder, and write nothing.
    const rnpHistBefore = await historyCount('rnp_ops');
    const auditBeforeLock = auditEntries().length;
    const blocked = await post(ACCEPT_PATH, { applicationId: RNP_LOCK_APP }, rnpOfficer);
    check('RNP accept of RDF-accepted citizen → 409 CROSS_AGENCY_LOCKED',
      blocked.status === 409 && blocked.json['status'] === 'CROSS_AGENCY_LOCKED', blocked.text);
    check('  response names the holding agency (RDF)', blocked.json['lockedByAgency'] === 'RDF', blocked.text);
    check('  RNP app untouched (still FINAL_SHORTLIST)', (await statusOf('rnp_ops', RNP_LOCK_APP)) === 'FINAL_SHORTLIST');
    check('  no history appended by the blocked accept', (await historyCount('rnp_ops')) === rnpHistBefore);
    check('  no audit emitted by the blocked accept', auditEntries().length === auditBeforeLock);
    check('  lock holder unchanged (still RDF)', (await lockOf(APPLICANT_ID))['cross_agency_locked_by_agency'] === 'RDF');

    // Idempotent re-accept by the HOLDING agency still returns NO_CHANGE —
    // the status guard fires before the lock check ever runs.
    const holderAgain = await post(ACCEPT_PATH, { applicationId: APP_HAPPY }, rdfOfficer);
    check('holder re-accept → 200 NO_CHANGE (status guard precedes lock)',
      holderAgain.status === 200 && holderAgain.json['status'] === 'NO_CHANGE', holderAgain.text);

    // Race: applicant D is FINAL_SHORTLISTed by RNP and RCS; both accept at
    // once. FOR UPDATE on the shared identity row serializes them — exactly
    // ONE 200 APPLIED, exactly one 409, and the lock names the winner.
    const [raceRnp, raceRcs] = await Promise.all([
      post(ACCEPT_PATH, { applicationId: RACE_RNP_APP }, rnpOfficer),
      post(ACCEPT_PATH, { applicationId: RACE_RCS_APP }, rcsOfficer),
    ]);
    const outcomes = [raceRnp, raceRcs].map((r) => r.json['status']);
    check('raced accepts → exactly one APPLIED and one CROSS_AGENCY_LOCKED',
      outcomes.filter((s) => s === 'APPLIED').length === 1 &&
        outcomes.filter((s) => s === 'CROSS_AGENCY_LOCKED').length === 1,
      `${raceRnp.status}:${raceRnp.text} | ${raceRcs.status}:${raceRcs.text}`);
    const rnpWon = raceRnp.json['status'] === 'APPLIED';
    const lockD = await lockOf(APPLICANT_D);
    check('  lock names the race winner', lockD['cross_agency_locked_by_agency'] === (rnpWon ? 'RNP' : 'RCS'), JSON.stringify(lockD));
    check('  winner app ACCEPTED, loser still FINAL_SHORTLIST',
      (await statusOf('rnp_ops', RACE_RNP_APP)) === (rnpWon ? 'ACCEPTED' : 'FINAL_SHORTLIST') &&
        (await statusOf('rcs_ops', RACE_RCS_APP)) === (rnpWon ? 'FINAL_SHORTLIST' : 'ACCEPTED'));
    check('  loser 409 names the winner', [raceRnp, raceRcs].find((r) => r.json['status'] === 'CROSS_AGENCY_LOCKED')?.json['lockedByAgency'] === (rnpWon ? 'RNP' : 'RCS'));

    // Lock responses carry no PII — status + agency code only.
    const lockResponses = [blocked, holderAgain, raceRnp, raceRcs].map((r) => r.text).join('|');
    check('no national_id_hash in lock responses',
      !lockResponses.includes(NID_HASH) && !lockResponses.includes(NID_HASH_D));
  } finally {
    await cleanup();
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('OFFICER LIFECYCLE (medical → final → accept) PROVEN (live) ✓');
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
