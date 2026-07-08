// ══════════════════════════════════════════════════════════════════
// application-service — Live vetting-PROJECTION self-check (ADR-006)
//
// Proves the application-state spine end-to-end over LIVE Kafka + Postgres:
//
//   publish NESA/HEC/RIB result ─► [application-service projection consumer]
//        (vetting.nesa/hec/rib)                     │
//                                                   ▼
//        ops applications row advanced (academic_status / criminal_clearance_
//        status / status), status-history appended, AUDIT_ENTRY emitted.
//
// The gates run in parallel and at-least-once, so the projection is proven
// idempotent, order-independent, monotonic, fail-closed, and cross-agency
// guarded. Repeatable: seeds a VERIFIED applicant + open campaigns, files its
// own SUBMITTED applications through the real repository, cleans up after.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   KAFKA_BROKERS='localhost:29092' \
//   pnpm --filter @usrp/application-service selfcheck:projection
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type {
  Agency,
  ApplicationCategory,
  AuditEvent,
  EligibilityResult,
  USRPEvent,
} from '@usrp/shared-types';
import { sql } from '@usrp/shared-database';
import { KafkaEventBus, newCorrelationContext, newEnvelope } from '@usrp/shared-events';
import {
  PgApplicationRepository,
  createApplicationService,
  loadApplicationConfig,
  startVettingResultConsumer,
} from '../src/index.js';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(',');
const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const APPLICANT_ID = '2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a';
const NID_HASH = 'a1b2c3d4'.repeat(8);
const RDF_CAMPAIGN = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c';
const RNP_CAMPAIGN = '6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup(): Promise<void> {
  for (const schema of ['rdf_ops', 'rnp_ops'] as const) {
    await admin`
      DELETE FROM ${admin(schema)}.application_status_history
      WHERE application_id IN (
        SELECT id FROM ${admin(schema)}.applications WHERE applicant_id = ${APPLICANT_ID}
      )`;
    await admin`DELETE FROM ${admin(schema)}.applications WHERE applicant_id = ${APPLICANT_ID}`;
  }
  await admin`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${admin([RDF_CAMPAIGN, RNP_CAMPAIGN])}`;
  await admin`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
}

async function seed(): Promise<void> {
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (${APPLICANT_ID}, ${NID_HASH}, 'x','x','x','x','MALE','WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${RDF_CAMPAIGN}, 'Projection RDF', 'RDF', 'REGISTRATION_OPEN',
       '["GENERAL_ENLISTMENT","RESERVE_FORCE_UNIVERSITY"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01','2026-09-15',7),
      (${RNP_CAMPAIGN}, 'Projection RNP', 'RNP', 'REGISTRATION_OPEN',
       '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01','2026-09-15',7)`;
}

// File a SUBMITTED application through the real repository; return its id.
async function fileApplication(
  repo: PgApplicationRepository,
  agency: Agency,
  campaignId: string,
  category: ApplicationCategory,
): Promise<string> {
  const res = await repo.createApplication({
    agency,
    applicantId: APPLICANT_ID,
    campaignId,
    category,
    channel: 'WEB',
    nesaIndexNumber: null,
    hecRegistrationNumber: null,
    correlationId: randomUUID(),
  });
  return res.applicationId;
}

interface StateRow {
  readonly status: string;
  readonly academic_status: string;
  readonly criminal_clearance_status: string;
  readonly criminal_clearance_at: Date | null;
  readonly nesa_verified_at: Date | null;
  readonly hec_verified_at: Date | null;
  readonly applied_criminal_threshold: string | null;
}

async function readState(schema: 'rdf_ops' | 'rnp_ops', appId: string): Promise<StateRow | undefined> {
  const col =
    schema === 'rnp_ops' ? admin`applied_criminal_threshold` : admin`NULL::text AS applied_criminal_threshold`;
  const rows = await admin<StateRow[]>`
    SELECT status, academic_status, criminal_clearance_status,
           criminal_clearance_at, nesa_verified_at, hec_verified_at, ${col}
    FROM ${admin(schema)}.applications WHERE id = ${appId}`;
  return rows[0];
}

async function historyRows(
  schema: 'rdf_ops' | 'rnp_ops',
  appId: string,
): Promise<{ from_status: string | null; to_status: string; correlation_id: string | null }[]> {
  return admin`
    SELECT from_status, to_status, correlation_id
    FROM ${admin(schema)}.application_status_history
    WHERE application_id = ${appId} ORDER BY performed_at`;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  desc: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`  ⏱ timed out waiting for: ${desc}`);
  return false;
}

const eligibility = (eligible: boolean): EligibilityResult => ({
  eligible,
  reason: eligible ? 'meets requirements' : 'does not meet requirements',
  evaluatedAt: '2026-07-08T00:00:00.000Z',
  details: {
    citizenshipCheck: true,
    ageCheck: true,
    educationCheck: eligible,
    criminalCheck: null,
    prosecutionCheck: null,
    dismissalCheck: null,
    moralCharacterCheck: null,
    healthCheck: null,
  },
});

function nesaEvent(appId: string, agency: Agency, category: ApplicationCategory, eligible: boolean): USRPEvent {
  return {
    ...newEnvelope(newCorrelationContext()),
    eventType: 'NESA_VERIFICATION_COMPLETED',
    applicantId: APPLICANT_ID,
    applicationId: appId,
    agency,
    category,
    nesaRequestId: randomUUID(),
    eligibilityResult: eligibility(eligible),
    academicStatus: eligible ? 'ELIGIBLE' : 'INELIGIBLE',
  };
}

function hecEvent(appId: string, agency: Agency, category: ApplicationCategory): USRPEvent {
  return {
    ...newEnvelope(newCorrelationContext()),
    eventType: 'HEC_VERIFICATION_COMPLETED',
    applicantId: APPLICANT_ID,
    applicationId: appId,
    agency,
    category,
    hecRequestId: randomUUID(),
    degreeVerified: true,
    institutionName: 'University of Rwanda',
    degreeTitle: 'BSc',
    graduationYear: 2023,
    specialistField: null,
    eligibilityResult: eligibility(true),
    academicStatus: 'ELIGIBLE',
  };
}

function ribEvent(
  appId: string,
  agency: Agency,
  category: ApplicationCategory,
  clearance: 'CLEARED' | 'FLAGGED_CONVICTION' | 'UNDER_REVIEW',
  threshold: 'ANY_CONVICTION' | 'IMPRISONMENT_GT_6MO' | 'IMPRISONMENT_GTE_6MO',
): USRPEvent {
  return {
    ...newEnvelope(newCorrelationContext()),
    eventType: 'RIB_VETTING_COMPLETED',
    applicantId: APPLICANT_ID,
    applicationId: appId,
    agency,
    category,
    ribRequestId: randomUUID(),
    clearanceStatus: clearance,
    appliedThreshold: threshold,
  };
}

async function main(): Promise<void> {
  const config = loadApplicationConfig();
  const repo = new PgApplicationRepository();

  await cleanup();
  await seed();

  // File one SUBMITTED application per scenario (all for the one applicant).
  const appAcademic = await fileApplication(repo, 'RDF', RDF_CAMPAIGN, 'GENERAL_ENLISTMENT');
  const appHec = await fileApplication(repo, 'RDF', RDF_CAMPAIGN, 'RESERVE_FORCE_UNIVERSITY');
  const appCriminal = await fileApplication(repo, 'RDF', RDF_CAMPAIGN, 'GENERAL_ENLISTMENT');
  const appReject = await fileApplication(repo, 'RDF', RDF_CAMPAIGN, 'GENERAL_ENLISTMENT');
  const appIdem = await fileApplication(repo, 'RDF', RDF_CAMPAIGN, 'GENERAL_ENLISTMENT');
  const appOrder = await fileApplication(repo, 'RDF', RDF_CAMPAIGN, 'GENERAL_ENLISTMENT');
  const appRnp = await fileApplication(repo, 'RNP', RNP_CAMPAIGN, 'CADET_OFFICER');
  console.log(`\nFiled 7 SUBMITTED applications for applicant ${APPLICANT_ID} — brokers ${BROKERS.join(',')}`);

  // Buses: the service consumes the vetting topics AND publishes AUDIT_ENTRY.
  const serviceBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'application-service' });
  const projector = createApplicationService(config, serviceBus).projector;
  const producerBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-projection-producer' });
  const auditBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-projection-audit' });

  const audits = new Map<string, AuditEvent[]>();
  await auditBus.subscribe(['audit.immutable'], `selfcheck-proj-audit-${randomUUID()}`, (event) => {
    if (event.eventType === 'AUDIT_ENTRY' && event.performedBy === 'application-service') {
      const list = audits.get(event.entityId) ?? [];
      list.push(event);
      audits.set(event.entityId, list);
    }
  });

  await startVettingResultConsumer(serviceBus, projector);
  await new Promise((r) => setTimeout(r, 5000)); // partition assignment

  // ── 1. Academic (NESA) → ACADEMIC_VETTING ─────────────────────────
  console.log('\n── 1. Academic verdict (NESA, ELIGIBLE) ─────────────────────');
  await producerBus.publish(nesaEvent(appAcademic, 'RDF', 'GENERAL_ENLISTMENT', true));
  await waitFor(async () => (await readState('rdf_ops', appAcademic))?.status === 'ACADEMIC_VETTING', 'appAcademic→ACADEMIC_VETTING');
  {
    const s = await readState('rdf_ops', appAcademic);
    check('academic_status = ELIGIBLE', s?.academic_status === 'ELIGIBLE', s?.academic_status);
    check('status = ACADEMIC_VETTING', s?.status === 'ACADEMIC_VETTING', s?.status);
    check('nesa_verified_at set', s?.nesa_verified_at != null);
    const hist = await historyRows('rdf_ops', appAcademic);
    check('history appended SUBMITTED→ACADEMIC_VETTING', hist.some((h) => h.from_status === 'SUBMITTED' && h.to_status === 'ACADEMIC_VETTING'));
    check('AUDIT_ENTRY APPLICATION_STATUS_ADVANCED', (audits.get(appAcademic) ?? []).some((a) => a.action === 'APPLICATION_STATUS_ADVANCED'));
  }

  // ── 2. Academic (HEC) writes the hec_ columns ─────────────────────
  console.log('\n── 2. Academic verdict (HEC) uses the hec_ columns ──────────');
  await producerBus.publish(hecEvent(appHec, 'RDF', 'RESERVE_FORCE_UNIVERSITY'));
  await waitFor(async () => (await readState('rdf_ops', appHec))?.status === 'ACADEMIC_VETTING', 'appHec→ACADEMIC_VETTING');
  {
    const s = await readState('rdf_ops', appHec);
    check('academic_status = ELIGIBLE (HEC)', s?.academic_status === 'ELIGIBLE');
    check('hec_verified_at set', s?.hec_verified_at != null);
    check('nesa_verified_at NOT set (HEC path)', s?.nesa_verified_at == null);
  }

  // ── 3. Criminal (RIB CLEARED) → CRIMINAL_CLEARANCE ────────────────
  console.log('\n── 3. Criminal verdict (RIB, CLEARED) ───────────────────────');
  await producerBus.publish(ribEvent(appCriminal, 'RDF', 'GENERAL_ENLISTMENT', 'CLEARED', 'ANY_CONVICTION'));
  await waitFor(async () => (await readState('rdf_ops', appCriminal))?.status === 'CRIMINAL_CLEARANCE', 'appCriminal→CRIMINAL_CLEARANCE');
  {
    const s = await readState('rdf_ops', appCriminal);
    check('criminal_clearance_status = CLEARED', s?.criminal_clearance_status === 'CLEARED', s?.criminal_clearance_status);
    check('status = CRIMINAL_CLEARANCE', s?.status === 'CRIMINAL_CLEARANCE', s?.status);
    check('criminal_clearance_at set', s?.criminal_clearance_at != null);
  }

  // ── 4. Hard fail (RIB FLAGGED_CONVICTION) → REJECTED ──────────────
  console.log('\n── 4. Hard fail (RIB, FLAGGED_CONVICTION) → REJECTED ────────');
  await producerBus.publish(ribEvent(appReject, 'RDF', 'GENERAL_ENLISTMENT', 'FLAGGED_CONVICTION', 'ANY_CONVICTION'));
  await waitFor(async () => (await readState('rdf_ops', appReject))?.status === 'REJECTED', 'appReject→REJECTED');
  {
    const s = await readState('rdf_ops', appReject);
    check('status = REJECTED (terminal)', s?.status === 'REJECTED', s?.status);
    check('criminal_clearance_status = FLAGGED_CONVICTION', s?.criminal_clearance_status === 'FLAGGED_CONVICTION');
    check('AUDIT_ENTRY APPLICATION_REJECTED', (audits.get(appReject) ?? []).some((a) => a.action === 'APPLICATION_REJECTED'));
  }

  // ── 5. RNP threshold persisted (UNDER_REVIEW, not a hard fail) ─────
  console.log('\n── 5. RNP criminal verdict persists applied_criminal_threshold ──');
  await producerBus.publish(ribEvent(appRnp, 'RNP', 'CADET_OFFICER', 'UNDER_REVIEW', 'IMPRISONMENT_GT_6MO'));
  await waitFor(async () => (await readState('rnp_ops', appRnp))?.status === 'CRIMINAL_CLEARANCE', 'appRnp→CRIMINAL_CLEARANCE');
  {
    const s = await readState('rnp_ops', appRnp);
    check('criminal_clearance_status = UNDER_REVIEW', s?.criminal_clearance_status === 'UNDER_REVIEW', s?.criminal_clearance_status);
    check('status = CRIMINAL_CLEARANCE (review is not a fail)', s?.status === 'CRIMINAL_CLEARANCE', s?.status);
    check('applied_criminal_threshold persisted', s?.applied_criminal_threshold === 'IMPRISONMENT_GT_6MO', String(s?.applied_criminal_threshold));
  }

  // ── 6. Idempotency: re-deliver the same academic verdict ──────────
  console.log('\n── 6. Idempotent redelivery (no duplicate history/state) ────');
  await producerBus.publish(nesaEvent(appIdem, 'RDF', 'GENERAL_ENLISTMENT', true));
  await waitFor(async () => (await readState('rdf_ops', appIdem))?.status === 'ACADEMIC_VETTING', 'appIdem→ACADEMIC_VETTING');
  const histBefore = (await historyRows('rdf_ops', appIdem)).length;
  await producerBus.publish(nesaEvent(appIdem, 'RDF', 'GENERAL_ENLISTMENT', true)); // second, same verdict
  await new Promise((r) => setTimeout(r, 4000)); // NO_CHANGE emits nothing to await
  {
    const histAfter = (await historyRows('rdf_ops', appIdem)).length;
    check('no extra history row on redelivery', histAfter === histBefore, `${histBefore}→${histAfter}`);
    const s = await readState('rdf_ops', appIdem);
    check('status still ACADEMIC_VETTING', s?.status === 'ACADEMIC_VETTING');
  }

  // ── 7. Order-independence: criminal BEFORE academic, no regression ─
  console.log('\n── 7. Out-of-order (criminal then academic), monotonic ──────');
  await producerBus.publish(ribEvent(appOrder, 'RDF', 'GENERAL_ENLISTMENT', 'CLEARED', 'ANY_CONVICTION'));
  await waitFor(async () => (await readState('rdf_ops', appOrder))?.status === 'CRIMINAL_CLEARANCE', 'appOrder→CRIMINAL_CLEARANCE');
  await producerBus.publish(nesaEvent(appOrder, 'RDF', 'GENERAL_ENLISTMENT', true));
  await waitFor(async () => (await readState('rdf_ops', appOrder))?.academic_status === 'ELIGIBLE', 'appOrder academic ELIGIBLE');
  {
    const s = await readState('rdf_ops', appOrder);
    check('academic_status = ELIGIBLE', s?.academic_status === 'ELIGIBLE');
    check('status STILL CRIMINAL_CLEARANCE (no regress to ACADEMIC_VETTING)', s?.status === 'CRIMINAL_CLEARANCE', s?.status);
    const hist = await historyRows('rdf_ops', appOrder);
    check('no ACADEMIC_VETTING history row written (monotonic)', !hist.some((h) => h.to_status === 'ACADEMIC_VETTING'));
  }

  // ── 8. Cross-agency guard: RNP-labelled event for an RDF app ───────
  console.log('\n── 8. Cross-agency guard (mis-routed event → NOT_FOUND) ─────');
  const guardApp = await fileApplication(repo, 'RDF', RDF_CAMPAIGN, 'GENERAL_ENLISTMENT');
  const before = await readState('rdf_ops', guardApp);
  // Same applicationId, but agency mislabelled RNP → projector targets rnp_ops.
  await producerBus.publish(ribEvent(guardApp, 'RNP', 'CADET_OFFICER', 'CLEARED', 'IMPRISONMENT_GT_6MO'));
  await new Promise((r) => setTimeout(r, 4000)); // NOT_FOUND emits nothing to await
  {
    const after = await readState('rdf_ops', guardApp);
    check('RDF row UNTOUCHED (criminal still PENDING)', after?.criminal_clearance_status === 'PENDING', after?.criminal_clearance_status);
    check('RDF row status unchanged', after?.status === before?.status, `${before?.status}→${after?.status}`);
    const rnpRows = await admin`SELECT id FROM rnp_ops.applications WHERE id = ${guardApp}`;
    check('no row created in rnp_ops for the RDF id', rnpRows.length === 0);
  }

  await Promise.all([serviceBus.disconnect(), producerBus.disconnect(), auditBus.disconnect()]);
  await cleanup();

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('APPLICATION-STATE PROJECTION PROVEN OVER LIVE KAFKA + PG ✓');
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
