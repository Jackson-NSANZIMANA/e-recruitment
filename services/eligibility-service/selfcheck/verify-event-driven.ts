// ══════════════════════════════════════════════════════════════════
// eligibility-service — Live EVENT-DRIVEN self-check (ADR-001 + ADR-005)
//
// Proves the async spine end-to-end through a LIVE Kafka broker: ONE submission
// fans out to BOTH eligibility gates (age + academic), each in its own consumer
// group, coupled to the trigger only by the backbone:
//
//   publish APPLICANT_SUBMITTED ─┬─► [age consumer]      ─► AGE audit on audit.immutable
//        (applicant.submitted)   └─► [academic consumer] ─► NESA_VERIFICATION_COMPLETED
//                                                            on vetting.nesa
//   (both reactions carry the SAME correlationId; causationId = the submitted
//    event's id — one causal chain, two independent gates.)
//
// The academic reaction is the one that did NOT exist before this slice — the
// NESA/HEC gate was HTTP-only, so the projection could never see academic state.
// No synchronous call between the trigger and either reaction — the gates are
// coupled only by the event backbone, exactly as the architecture claims.
// Repeatable: seeds + cleans its own identity fixture. Requires tier2 Kafka
// (host listener :29092) and Tier-1 Postgres.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   KAFKA_BROKERS='localhost:29092' \
//   pnpm --filter @usrp/eligibility-service selfcheck:events
// ══════════════════════════════════════════════════════════════════

import { randomUUID, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { ApplicantSubmittedEvent, AuditEvent, NESAVerificationCompletedEvent } from '@usrp/shared-types';
import { sql } from '@usrp/shared-database';
import { KafkaEventBus, newCorrelationContext, newEnvelope } from '@usrp/shared-events';
import {
  createEligibilityService,
  loadEligibilityConfig,
  startApplicantSubmittedConsumer,
  startAcademicVettingConsumer,
} from '../src/index.js';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(',');
const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const FIXTURE_DOB = '2003-03-15'; // age ~23
const CATEGORY = 'GENERAL_ENLISTMENT'; // RDF, band 18–25 → eligible

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function seedVerifiedIdentity(encryptionKey: string, nationalIdHash: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_system_service`;
    await tx`SELECT set_config('app.encryption_key', ${encryptionKey}, true)`;
    const rows = await tx<{ id: string }[]>`
      INSERT INTO public_core.applicant_identities
        (national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, gender,
         registration_channel, identity_status, nida_verification_request_id,
         nida_verified_at, nida_match_confidence, phone_number_hash)
      VALUES (
        ${nationalIdHash},
        pgp_sym_encrypt('Event Fixture', current_setting('app.encryption_key')),
        pgp_sym_encrypt(${FIXTURE_DOB},  current_setting('app.encryption_key')),
        pgp_sym_encrypt('GASABO',        current_setting('app.encryption_key')),
        pgp_sym_encrypt('KIGALI_CITY',   current_setting('app.encryption_key')),
        'MALE'::public_core.gender, 'WEB'::public_core.application_channel,
        'VERIFIED'::public_core.identity_verification_status,
        ${randomUUID()}, now(), null, null
      )
      RETURNING id
    `;
    const row = rows[0];
    if (!row) throw new Error('fixture insert returned no row');
    return row.id;
  });
}

async function main(): Promise<void> {
  // Supply harmless G2G defaults for the shared config (the academic consumer
  // builds the NESA + HEC gateways). Env still wins so the gate's centralised
  // env overrides these.
  const config = loadEligibilityConfig({
    NESA_BASE_URL: 'http://localhost:3101',
    NESA_HMAC_SECRET: 'dev_nesa_hmac_secret',
    HEC_BASE_URL: 'http://localhost:3103',
    HEC_HMAC_SECRET: 'dev_hec_hmac_secret',
    ...process.env,
  });
  const nationalIdHash = randomBytes(32).toString('hex');
  await admin`DELETE FROM public_core.applicant_identities WHERE national_id_hash = ${nationalIdHash}`;
  const applicantId = await seedVerifiedIdentity(config.security.encryptionKey, nationalIdHash);
  console.log(`\nSeeded VERIFIED applicant ${applicantId} (age ~23) — brokers ${BROKERS.join(',')}`);

  // The eligibility service's own bus: consumes applicant.submitted AND
  // publishes its AUDIT_ENTRY — both to real Kafka.
  const serviceBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'eligibility-service' });
  const services = createEligibilityService(config, serviceBus);

  // Independent observers — how we SEE the reactions on the backbone.
  const auditBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-audit-observer' });
  const nesaBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-nesa-observer' });
  const producerBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-producer' });

  const APPLICATION_ID = '99999999-9999-4999-8999-999999999999'; // synthetic — gates don't persist here
  const NESA_INDEX = `EVT-${randomUUID().slice(0, 8)}`; // unknown to the mock → NOT_FOUND → fail-closed completion

  let resolveAudit: (e: AuditEvent) => void;
  const auditSeen = new Promise<AuditEvent>((resolve) => {
    resolveAudit = resolve;
  });
  let resolveNesa: (e: NESAVerificationCompletedEvent) => void;
  const nesaSeen = new Promise<NESAVerificationCompletedEvent>((resolve) => {
    resolveNesa = resolve;
  });

  // 1) Observe audit.immutable for OUR applicant's AGE decision.
  await auditBus.subscribe(['audit.immutable'], `selfcheck-audit-${randomUUID()}`, (event) => {
    if (event.eventType === 'AUDIT_ENTRY' && event.entityId === applicantId && event.action.startsWith('AGE_')) {
      resolveAudit(event);
    }
  });
  // 2) Observe vetting.nesa for OUR application's ACADEMIC verdict — this is the
  //    reaction that did NOT exist before the academic gate went event-driven.
  await nesaBus.subscribe(['vetting.nesa'], `selfcheck-nesa-${randomUUID()}`, (event) => {
    if (event.eventType === 'NESA_VERIFICATION_COMPLETED' && event.applicationId === APPLICATION_ID) {
      resolveNesa(event);
    }
  });
  // 3) Start BOTH real eligibility consumers on applicant.submitted (age + academic).
  await startApplicantSubmittedConsumer(serviceBus, services.age);
  await startAcademicVettingConsumer(serviceBus, { education: services.education, degree: services.degree });
  // All consumer groups join at the log end — let them get partition
  // assignments before we publish, or the trigger is missed.
  await new Promise((r) => setTimeout(r, 5000));

  // 4) Publish ONE trigger carrying a NESA index → BOTH gates must react.
  const ctx = newCorrelationContext();
  const submitted: ApplicantSubmittedEvent = {
    ...newEnvelope(ctx),
    eventType: 'APPLICANT_SUBMITTED',
    applicantId,
    applicationId: APPLICATION_ID,
    nationalIdHash,
    agency: 'RDF',
    category: CATEGORY,
    channel: 'WEB',
    nesaIndexNumber: NESA_INDEX,
    hecRegistrationNumber: null,
  };
  await producerBus.publish(submitted);
  console.log(`  → published APPLICANT_SUBMITTED eventId=${submitted.eventId} correlationId=${submitted.correlationId}`);

  const timeout = (label: string): Promise<never> =>
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after 30s waiting for the ${label} reaction`)), 30_000),
    );
  const audit = await Promise.race([auditSeen, timeout('AGE AUDIT_ENTRY')]);

  console.log('\n── Reaction 1: the AGE gate reacted over the backbone ───────');
  check('AUDIT_ENTRY observed for our applicant', audit.entityId === applicantId);
  check('action is AGE_ELIGIBILITY_PASSED', audit.action === 'AGE_ELIGIBILITY_PASSED', audit.action);
  check('performedBy is eligibility-service', audit.performedBy === 'eligibility-service');
  check('agency attributed to RDF', audit.agency === 'RDF', String(audit.agency));
  check('correlationId preserved from the trigger', audit.correlationId === submitted.correlationId, audit.correlationId);
  check('causationId === the submitted event id (causal chain)', audit.causationId === submitted.eventId, `${audit.causationId} vs ${submitted.eventId}`);
  const meta = audit.metadata ?? {};
  check('metadata.eligible === true', meta['eligible'] === true, JSON.stringify(meta));
  check('metadata.ageAtEvaluation === 23', meta['ageAtEvaluation'] === 23, String(meta['ageAtEvaluation']));
  check('metadata.category === GENERAL_ENLISTMENT', meta['category'] === CATEGORY);
  const auditJson = JSON.stringify(audit);
  check('raw DOB absent from the audit event', !auditJson.includes(FIXTURE_DOB));

  const nesa = await Promise.race([nesaSeen, timeout('NESA_VERIFICATION_COMPLETED')]);

  console.log('\n── Reaction 2: the ACADEMIC gate reacted (NEW — event-driven) ──');
  check('NESA_VERIFICATION_COMPLETED observed for our application', nesa.applicationId === APPLICATION_ID);
  check('academic verdict present on the event', typeof nesa.academicStatus === 'string', String(nesa.academicStatus));
  check('agency attributed to RDF', nesa.agency === 'RDF', String(nesa.agency));
  check('correlationId preserved from the SAME trigger (one submission, two gates)', nesa.correlationId === submitted.correlationId, nesa.correlationId);
  check('causationId === the submitted event id (causal chain)', nesa.causationId === submitted.eventId, `${nesa.causationId} vs ${submitted.eventId}`);

  await Promise.all([serviceBus.disconnect(), auditBus.disconnect(), nesaBus.disconnect(), producerBus.disconnect()]);
  await admin`DELETE FROM public_core.applicant_identities WHERE national_id_hash = ${nationalIdHash}`;

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('EVENT-DRIVEN AGE + ACADEMIC ELIGIBILITY PROVEN OVER LIVE KAFKA ✓');
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
