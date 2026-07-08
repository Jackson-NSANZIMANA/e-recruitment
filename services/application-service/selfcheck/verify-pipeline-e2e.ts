// ══════════════════════════════════════════════════════════════════
// application-service — FULL-CHAIN pipeline self-check (the whole spine)
//
// Every other proof exercises ONE service. This one proves the COMPOSITION: a
// single real front-door submission fans out over live Kafka to all three
// vetting gates — running as their real service objects, NOT hand-fed synthetic
// events — and the application-state projection advances the row to the positive
// terminal.
//
//   app.submit.submit(...) ─► APPLICANT_SUBMITTED
//        ├─► [eligibility age consumer]      ─► AGE_ELIGIBILITY_COMPLETED  ─┐
//        ├─► [eligibility academic consumer] ─► NESA_VERIFICATION_COMPLETED ─┼─► [application-service
//        └─► [background-vetting consumer]   ─► RIB_VETTING_COMPLETED       ─┘    projection consumer]
//                                                                                        │
//                                          rdf_ops.applications.status ── DOCUMENT_REVIEW_GREEN
//
// This is the proof that the system answers its reason for existing — "is this
// applicant eligible?" — end to end, with no service stubbed and no verdict
// fabricated. Before the academic gate went event-driven this could never turn
// green: academic_status stayed PENDING. It also proves the fail path: a missing
// NESA record drives a second application to REJECTED.
//
// Fixtures arranged so all three gates PASS for the green applicant:
//   • age — DOB 2003-03-15 → ~23, inside GENERAL_ENLISTMENT band (18–25)
//   • academic — NESA index RW2024/1001 → A-Level A2, meets GENERAL_ENLISTMENT
//   • criminal — a random nationalIdHash is UNKNOWN to the RIB mock → CLEAR
// The reject applicant uses NESA index RW2024/NOPE (not found → INELIGIBLE).
//
// Repeatable: seeds a VERIFIED identity + open RDF campaign, files through the
// real repository, cleans up. Requires tier1 Postgres + NESA/RIB mocks and
// tier2 Kafka (host listener :29092), plus the vetting.age topic.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   NESA_BASE_URL='http://localhost:3101' NESA_HMAC_SECRET='dev_nesa_hmac_secret' \
//   HEC_BASE_URL='http://localhost:3103'  HEC_HMAC_SECRET='dev_hec_hmac_secret' \
//   RIB_BASE_URL='http://localhost:3102'  RIB_HMAC_SECRET='dev_rib_hmac_secret' \
//   KAFKA_BROKERS='localhost:29092' \
//   pnpm --filter @usrp/application-service selfcheck:pipeline
// ══════════════════════════════════════════════════════════════════

import { randomUUID, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { ApplicationCategory } from '@usrp/shared-types';
import { sql } from '@usrp/shared-database';
import { KafkaEventBus } from '@usrp/shared-events';
import {
  createApplicationService,
  loadApplicationConfig,
  startVettingResultConsumer,
} from '../src/index.js';
import {
  createEligibilityService,
  loadEligibilityConfig,
  startApplicantSubmittedConsumer as startAgeConsumer,
  startAcademicVettingConsumer,
} from '@usrp/eligibility-service';
import {
  createBackgroundVettingService,
  loadBackgroundVettingConfig,
  startApplicantSubmittedConsumer as startCriminalConsumer,
} from '@usrp/background-vetting-service';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(',');
const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });
const ENCRYPTION_KEY = process.env['PII_ENCRYPTION_KEY'] ?? 'dev_pii_encryption_key_min_32_chars_ok!!';

const FIXTURE_DOB = '2003-03-15'; // ~23 → inside GENERAL_ENLISTMENT band
const CATEGORY: ApplicationCategory = 'GENERAL_ENLISTMENT'; // RDF
const RDF_CAMPAIGN = '7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d';
// Distinct applicants so the two scenarios never share vetting state.
const GREEN_APPLICANT = '3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b';
const REJECT_APPLICANT = '4c4c4c4c-4c4c-4c4c-8c4c-4c4c4c4c4c4c';
// Random hashes → UNKNOWN to the RIB mock → CLEAR (criminal passes for both).
const GREEN_HASH = randomBytes(32).toString('hex');
const REJECT_HASH = randomBytes(32).toString('hex');

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup(): Promise<void> {
  // application_status_history is append-only (0007 trigger binds every role),
  // so teardown deletes run inside the documented superuser escape hatch —
  // triggers (immutability + FK) disabled for this maintenance tx only.
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const applicant of [GREEN_APPLICANT, REJECT_APPLICANT]) {
      await tx`
        DELETE FROM rdf_ops.application_status_history
        WHERE application_id IN (SELECT id FROM rdf_ops.applications WHERE applicant_id = ${applicant})`;
      await tx`DELETE FROM rdf_ops.applications WHERE applicant_id = ${applicant}`;
    }
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${RDF_CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx([GREEN_APPLICANT, REJECT_APPLICANT])}`;
  });
}

async function seedIdentity(id: string, nationalIdHash: string): Promise<void> {
  // Seed via the app role assuming usrp_system_service — the proven path under
  // FORCE'd RLS (mirrors the education/age self-checks), so the encrypted DOB
  // the age gate later decrypts is written by the same role model.
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_system_service`;
    await tx`SELECT set_config('app.encryption_key', ${ENCRYPTION_KEY}, true)`;
    await tx`
      INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, gender,
         registration_channel, identity_status, nida_verification_request_id,
         nida_verified_at, nida_match_confidence, phone_number_hash)
      VALUES (
        ${id}, ${nationalIdHash},
        pgp_sym_encrypt('Pipeline Person', current_setting('app.encryption_key')),
        pgp_sym_encrypt(${FIXTURE_DOB},    current_setting('app.encryption_key')),
        pgp_sym_encrypt('GASABO',          current_setting('app.encryption_key')),
        pgp_sym_encrypt('KIGALI_CITY',     current_setting('app.encryption_key')),
        'MALE'::public_core.gender, 'WEB'::public_core.application_channel,
        'VERIFIED'::public_core.identity_verification_status,
        ${randomUUID()}, now(), null, null
      )`;
  });
}

async function seedCampaign(): Promise<void> {
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${RDF_CAMPAIGN}, 'Pipeline RDF', 'RDF', 'REGISTRATION_OPEN',
       '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01','2026-09-15',7)`;
}

interface StateRow {
  readonly status: string;
  readonly age_eligibility_status: string;
  readonly academic_status: string;
  readonly criminal_clearance_status: string;
}

async function readState(appId: string): Promise<StateRow | undefined> {
  const rows = await admin<StateRow[]>`
    SELECT status, age_eligibility_status, academic_status, criminal_clearance_status
    FROM rdf_ops.applications WHERE id = ${appId}`;
  return rows[0];
}

async function historyToStatuses(appId: string): Promise<string[]> {
  const rows = await admin<{ to_status: string }[]>`
    SELECT to_status FROM rdf_ops.application_status_history
    WHERE application_id = ${appId} ORDER BY performed_at`;
  return rows.map((r) => r.to_status);
}

async function waitFor(predicate: () => Promise<boolean>, desc: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`  ⏱ timed out waiting for: ${desc}`);
  return false;
}

async function main(): Promise<void> {
  // Configs — env wins; harmless dev defaults keep the check runnable directly.
  const appConfig = loadApplicationConfig();
  const eligConfig = loadEligibilityConfig({
    NESA_BASE_URL: 'http://localhost:3101',
    NESA_HMAC_SECRET: 'dev_nesa_hmac_secret',
    HEC_BASE_URL: 'http://localhost:3103',
    HEC_HMAC_SECRET: 'dev_hec_hmac_secret',
    ...process.env,
  });
  const bvConfig = loadBackgroundVettingConfig({
    RIB_BASE_URL: 'http://localhost:3102',
    RIB_HMAC_SECRET: 'dev_rib_hmac_secret',
    ...process.env,
  });

  await cleanup();
  await seedIdentity(GREEN_APPLICANT, GREEN_HASH);
  await seedIdentity(REJECT_APPLICANT, REJECT_HASH);
  await seedCampaign();
  console.log(`\nSeeded 2 VERIFIED applicants + open RDF campaign — brokers ${BROKERS.join(',')}`);

  // One bus per service (own consumer groups + own publishes), as in production.
  const appBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'application-service' });
  const eligBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'eligibility-service' });
  const bvBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'background-vetting-service' });
  await Promise.all([appBus.connect(), eligBus.connect(), bvBus.connect()]);

  // Assemble the REAL services and start their REAL consumers — the whole spine.
  const app = createApplicationService(appConfig, appBus);
  const elig = createEligibilityService(eligConfig, eligBus);
  const bv = createBackgroundVettingService(bvConfig, bvBus);

  await startVettingResultConsumer(appBus, app.projector); // age+academic+criminal → row
  await startAgeConsumer(eligBus, elig.age); // APPLICANT_SUBMITTED → age gate
  await startAcademicVettingConsumer(eligBus, { education: elig.education, degree: elig.degree });
  await startCriminalConsumer(bvBus, bv.criminalClearance); // APPLICANT_SUBMITTED → RIB gate

  // Let every consumer group get its partition assignment before we submit.
  await new Promise((r) => setTimeout(r, 6000));

  // ── Scenario 1: the green lane — one submission drives all three gates ─
  console.log('\n── 1. All three gates pass end-to-end → DOCUMENT_REVIEW_GREEN ──');
  const green = await app.submit.submit({
    applicantId: GREEN_APPLICANT,
    category: CATEGORY,
    channel: 'WEB',
    nesaIndexNumber: 'RW2024/1001', // known-good A-Level fixture
    hecRegistrationNumber: null,
  });
  check('front door returned SUBMITTED', green.kind === 'SUBMITTED', green.kind);
  if (green.kind !== 'SUBMITTED') {
    await teardown([appBus, eligBus, bvBus]);
    return finish();
  }
  const greenApp = green.applicationId;
  console.log(`  → filed ${green.processingCode} (${greenApp}); awaiting autonomous vetting…`);

  const reachedGreen = await waitFor(
    async () => (await readState(greenApp))?.status === 'DOCUMENT_REVIEW_GREEN',
    'greenApp → DOCUMENT_REVIEW_GREEN',
  );
  {
    const s = await readState(greenApp);
    check('status = DOCUMENT_REVIEW_GREEN (positive terminal reached from ONE submission)', reachedGreen && s?.status === 'DOCUMENT_REVIEW_GREEN', s?.status);
    check('age_eligibility_status = ELIGIBLE (age gate fired)', s?.age_eligibility_status === 'ELIGIBLE', s?.age_eligibility_status);
    check('academic_status = ELIGIBLE (academic gate fired — the new event path)', s?.academic_status === 'ELIGIBLE', s?.academic_status);
    check('criminal_clearance_status = CLEARED (criminal gate fired)', s?.criminal_clearance_status === 'CLEARED', s?.criminal_clearance_status);
    const hist = await historyToStatuses(greenApp);
    check('history includes SUBMITTED → … → DOCUMENT_REVIEW_GREEN', hist[0] === 'SUBMITTED' && hist.includes('DOCUMENT_REVIEW_GREEN'), hist.join('→'));
  }

  // ── Scenario 2: the fail path — missing NESA record → REJECTED ────────
  console.log('\n── 2. Missing academic record end-to-end → REJECTED (fail-closed) ──');
  const reject = await app.submit.submit({
    applicantId: REJECT_APPLICANT,
    category: CATEGORY,
    channel: 'WEB',
    nesaIndexNumber: 'RW2024/NOPE', // unknown → NESA INELIGIBLE
    hecRegistrationNumber: null,
  });
  check('front door returned SUBMITTED', reject.kind === 'SUBMITTED', reject.kind);
  if (reject.kind === 'SUBMITTED') {
    const rejApp = reject.applicationId;
    console.log(`  → filed ${reject.processingCode} (${rejApp}); awaiting autonomous vetting…`);
    const reachedReject = await waitFor(
      async () => (await readState(rejApp))?.status === 'REJECTED',
      'rejectApp → REJECTED',
    );
    const s = await readState(rejApp);
    check('status = REJECTED (a missing NESA record hard-fails the whole pipeline)', reachedReject && s?.status === 'REJECTED', s?.status);
    check('academic_status = INELIGIBLE', s?.academic_status === 'INELIGIBLE', s?.academic_status);
  }

  await teardown([appBus, eligBus, bvBus]);
  await cleanup();
  finish();
}

async function teardown(buses: readonly KafkaEventBus[]): Promise<void> {
  await Promise.all(buses.map((b) => b.disconnect()));
}

function finish(): void {
  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('FULL PIPELINE PROVEN — ONE SUBMISSION → 3 GATES → DOCUMENT_REVIEW_GREEN, OVER LIVE KAFKA + PG + G2G ✓');
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
