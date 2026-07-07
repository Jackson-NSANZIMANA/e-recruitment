// ══════════════════════════════════════════════════════════════════
// eligibility-service — Live EVENT-DRIVEN self-check (ADR-001 + ADR-005)
//
// Proves the async spine end-to-end through a LIVE Kafka broker:
//
//   publish APPLICANT_SUBMITTED  ─►  [eligibility consumer]  ─►  age gate
//        (applicant.submitted)                                     │
//                                                                  ▼
//                              AUDIT_ENTRY observed on audit.immutable
//                              (correlationId preserved, causationId =
//                               the submitted event's id — full causal chain)
//
// No synchronous call between the trigger and the reaction — the services
// are coupled only by the event backbone, exactly as the architecture claims.
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
import type { ApplicantSubmittedEvent, AuditEvent } from '@usrp/shared-types';
import { sql } from '@usrp/shared-database';
import { KafkaEventBus, newCorrelationContext, newEnvelope } from '@usrp/shared-events';
import {
  createEligibilityService,
  loadEligibilityConfig,
  startApplicantSubmittedConsumer,
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
  const config = loadEligibilityConfig();
  const nationalIdHash = randomBytes(32).toString('hex');
  await admin`DELETE FROM public_core.applicant_identities WHERE national_id_hash = ${nationalIdHash}`;
  const applicantId = await seedVerifiedIdentity(config.security.encryptionKey, nationalIdHash);
  console.log(`\nSeeded VERIFIED applicant ${applicantId} (age ~23) — brokers ${BROKERS.join(',')}`);

  // The eligibility service's own bus: consumes applicant.submitted AND
  // publishes its AUDIT_ENTRY — both to real Kafka.
  const serviceBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'eligibility-service' });
  const service = createEligibilityService(config, serviceBus);

  // Independent observer of the audit topic — how we SEE the reaction.
  const auditBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-audit-observer' });
  const producerBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-producer' });

  let resolveAudit: (e: AuditEvent) => void;
  const auditSeen = new Promise<AuditEvent>((resolve) => {
    resolveAudit = resolve;
  });

  // 1) Observe audit.immutable for OUR applicant's decision.
  await auditBus.subscribe(['audit.immutable'], `selfcheck-audit-${randomUUID()}`, (event) => {
    if (event.eventType === 'AUDIT_ENTRY' && event.entityId === applicantId) {
      resolveAudit(event);
    }
  });
  // 2) Start the real eligibility consumer on applicant.submitted.
  await startApplicantSubmittedConsumer(serviceBus, service);
  // Both consumer groups join at the log end — let them get partition
  // assignments before we publish, or the trigger is missed.
  await new Promise((r) => setTimeout(r, 5000));

  // 3) Publish the trigger.
  const ctx = newCorrelationContext();
  const submitted: ApplicantSubmittedEvent = {
    ...newEnvelope(ctx),
    eventType: 'APPLICANT_SUBMITTED',
    applicantId,
    nationalIdHash,
    agency: 'RDF',
    category: CATEGORY,
    channel: 'WEB',
    nesaIndexNumber: null,
    hecRegistrationNumber: null,
  };
  await producerBus.publish(submitted);
  console.log(`  → published APPLICANT_SUBMITTED eventId=${submitted.eventId} correlationId=${submitted.correlationId}`);

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timed out after 30s waiting for the AUDIT_ENTRY reaction')), 30_000),
  );
  const audit = await Promise.race([auditSeen, timeout]);

  console.log('\n── The reaction arrived over the backbone ───────────────────');
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

  await Promise.all([serviceBus.disconnect(), auditBus.disconnect(), producerBus.disconnect()]);
  await admin`DELETE FROM public_core.applicant_identities WHERE national_id_hash = ${nationalIdHash}`;

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('EVENT-DRIVEN AGE ELIGIBILITY PROVEN OVER LIVE KAFKA ✓');
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
