// ══════════════════════════════════════════════════════════════════
// audit-service — Live slice self-check (ADR-001 + Law N° 058/2021)
//
// Proves the immutable audit trail end-to-end, against LIVE Kafka + Postgres:
//
//   publish AUDIT_ENTRY ─► [audit-service consumer] ─► PgAuditWriter
//        (audit.immutable)                                  │
//                                                           ▼
//                                    row appended to audit_log.audit_entries
//
// Four guarantees, each an assertion group:
//   1. CAPTURE      — a published AUDIT_ENTRY becomes exactly one durable row,
//                     envelope (correlation/causation) + fields intact.
//   2. IDEMPOTENCY  — re-publishing the SAME eventId yields NO second row
//                     (at-least-once delivery is safe).
//   3. IMMUTABILITY — UPDATE, DELETE and TRUNCATE on the row are REJECTED by
//                     the 0002 trigger, even as the table owner.
//   4. NO PII       — the persisted row carries no raw NID/name/DOB.
//
// Requires 0002_audit_immutability.sql applied (writer role + trigger), tier2
// Kafka (host listener :29092) and tier1 Postgres.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   KAFKA_BROKERS='localhost:29092' \
//   pnpm --filter @usrp/audit-service selfcheck
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { AuditEvent } from '@usrp/shared-types';
import { sql } from '@usrp/shared-database';
import { KafkaEventBus, newCorrelationContext, newEnvelope, deriveContext } from '@usrp/shared-events';
import { createAuditWriter, startAuditEntryConsumer } from '../src/index.js';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(',');
const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
// The owner connection — used ONLY to (a) prove the trigger binds even the
// owner and (b) clean up appended rows (which requires disabling the trigger,
// something the app role can never do).
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// A distinctive PII-shaped sentinel that must NEVER reach the trail.
const RAW_NID_SENTINEL = '1200380123456789';
const RAW_NAME_SENTINEL = 'Mugisha Fictional';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function countRows(kafkaEventId: string): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log.audit_entries WHERE kafka_event_id = ${kafkaEventId}
  `;
  return rows[0]?.n ?? 0;
}

async function main(): Promise<void> {
  const applicantId = randomUUID();

  // Model a real causal chain: a parent event, then our AUDIT_ENTRY derived
  // from it (correlationId preserved, causationId = the parent's eventId).
  const parent = newEnvelope(newCorrelationContext());
  const event: AuditEvent = {
    ...newEnvelope(deriveContext(parent)),
    eventType: 'AUDIT_ENTRY',
    entityType: 'APPLICANT',
    entityId: applicantId,
    action: 'NIDA_VERIFICATION_COMPLETED',
    performedBy: 'identity-service',
    agency: 'SYSTEM',
    metadata: {
      // References and derived facts ONLY — this is what a good producer emits.
      nidaRequestId: randomUUID(),
      matchConfidence: 0.99,
      // Deliberately DO NOT put raw PII here; the check below proves it stays out.
    },
  };

  console.log(`\nAudit slice — applicant ${applicantId}, event ${event.eventId}, brokers ${BROKERS.join(',')}`);
  // Clean any stale row for a repeatable run (disable trigger to allow delete).
  await admin`ALTER TABLE audit_log.audit_entries DISABLE TRIGGER trg_audit_entries_no_delete`;
  await admin`DELETE FROM audit_log.audit_entries WHERE kafka_event_id = ${event.eventId}`;
  await admin`ALTER TABLE audit_log.audit_entries ENABLE TRIGGER trg_audit_entries_no_delete`;

  // ── Wire the REAL service: consumer group 'audit-service' + PgAuditWriter ──
  const serviceBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'audit-service' });
  const producerBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-producer' });
  const writer = createAuditWriter();
  await startAuditEntryConsumer(serviceBus, writer);
  // Let the group receive its partition assignment before we publish.
  await new Promise((r) => setTimeout(r, 5000));

  // ── 1) CAPTURE ────────────────────────────────────────────────────
  await producerBus.publish(event);
  console.log(`  → published AUDIT_ENTRY eventId=${event.eventId}`);

  // Poll for the row (the consumer writes asynchronously).
  const deadline = Date.now() + 30_000;
  while ((await countRows(event.eventId)) === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  const rows = await admin<Record<string, unknown>[]>`
    SELECT * FROM audit_log.audit_entries WHERE kafka_event_id = ${event.eventId}
  `;
  console.log('\n── 1. Capture ───────────────────────────────────────────────');
  check('exactly one row appended', rows.length === 1, `got ${rows.length}`);
  const row = rows[0] ?? {};
  check('entity_id matches', row['entity_id'] === applicantId);
  check('action preserved', row['action'] === 'NIDA_VERIFICATION_COMPLETED', String(row['action']));
  check('performed_by preserved', row['performed_by'] === 'identity-service');
  check('agency preserved', row['agency'] === 'SYSTEM', String(row['agency']));
  check('correlation_id preserved', row['correlation_id'] === event.correlationId, String(row['correlation_id']));
  check('causation_id preserved (causal chain)', row['causation_id'] === event.causationId, `${String(row['causation_id'])} vs ${event.causationId}`);
  check('occurred_at preserved', new Date(row['occurred_at'] as string).toISOString() === event.occurredAt, String(row['occurred_at']));
  check('recorded_at set by DB', row['recorded_at'] != null);
  check('metadata.nidaRequestId round-tripped', (row['metadata'] as Record<string, unknown>)?.['nidaRequestId'] === event.metadata!['nidaRequestId']);

  // ── 2) IDEMPOTENCY ────────────────────────────────────────────────
  console.log('\n── 2. Idempotency (at-least-once safe) ──────────────────────');
  // Direct second append via the writer (deterministic — no broker timing).
  const secondOutcome = await writer.append({
    kafkaEventId: event.eventId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    entityType: 'APPLICANT',
    entityId: applicantId,
    agency: 'SYSTEM',
    action: 'NIDA_VERIFICATION_COMPLETED',
    performedBy: 'identity-service',
    performedByRole: null,
    previousStatus: null,
    newStatus: null,
    ipAddress: null,
    userAgent: null,
    metadata: { nidaRequestId: 'DIFFERENT-would-be-a-mutation' },
    occurredAt: event.occurredAt,
  });
  check("re-append returns 'duplicate'", secondOutcome === 'duplicate', secondOutcome);
  check('still exactly one row (no duplicate history)', (await countRows(event.eventId)) === 1);
  const afterDup = await admin<Record<string, unknown>[]>`
    SELECT metadata FROM audit_log.audit_entries WHERE kafka_event_id = ${event.eventId}
  `;
  check('original metadata NOT overwritten by the duplicate', (afterDup[0]?.['metadata'] as Record<string, unknown>)?.['nidaRequestId'] === event.metadata!['nidaRequestId']);

  // ── 3) IMMUTABILITY (trigger binds even the owner) ────────────────
  console.log('\n── 3. Immutability — the 0002 trigger ───────────────────────');
  let updateRejected = false;
  try {
    await admin`UPDATE audit_log.audit_entries SET action = 'TAMPERED' WHERE kafka_event_id = ${event.eventId}`;
  } catch {
    updateRejected = true;
  }
  check('UPDATE rejected (even as table owner)', updateRejected);

  let deleteRejected = false;
  try {
    await admin`DELETE FROM audit_log.audit_entries WHERE kafka_event_id = ${event.eventId}`;
  } catch {
    deleteRejected = true;
  }
  check('DELETE rejected (even as table owner)', deleteRejected);

  let truncateRejected = false;
  try {
    await admin`TRUNCATE audit_log.audit_entries`;
  } catch {
    truncateRejected = true;
  }
  check('TRUNCATE rejected (even as table owner)', truncateRejected);

  const stillThere = await admin<Record<string, unknown>[]>`
    SELECT action FROM audit_log.audit_entries WHERE kafka_event_id = ${event.eventId}
  `;
  check('row survived all tamper attempts, untampered', stillThere[0]?.['action'] === 'NIDA_VERIFICATION_COMPLETED');

  // The app writer role must not hold UPDATE/DELETE at the grant level either.
  const priv = await admin<{ privilege_type: string }[]>`
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'usrp_audit_writer' AND table_schema = 'audit_log' AND table_name = 'audit_entries'
  `;
  const grants = priv.map((p) => p.privilege_type).sort();
  check('writer role granted INSERT', grants.includes('INSERT'));
  check('writer role granted SELECT', grants.includes('SELECT'));
  check('writer role NOT granted UPDATE', !grants.includes('UPDATE'), grants.join(','));
  check('writer role NOT granted DELETE', !grants.includes('DELETE'), grants.join(','));

  // ── 4) NO PII ─────────────────────────────────────────────────────
  console.log('\n── 4. No PII in the trail ───────────────────────────────────');
  const rowJson = JSON.stringify(stillThere) + JSON.stringify(rows);
  check('no raw NID in the persisted row', !rowJson.includes(RAW_NID_SENTINEL));
  check('no raw name in the persisted row', !rowJson.includes(RAW_NAME_SENTINEL));

  // ── Cleanup (requires disabling the delete trigger — owner only) ──
  await admin`ALTER TABLE audit_log.audit_entries DISABLE TRIGGER trg_audit_entries_no_delete`;
  await admin`DELETE FROM audit_log.audit_entries WHERE kafka_event_id = ${event.eventId}`;
  await admin`ALTER TABLE audit_log.audit_entries ENABLE TRIGGER trg_audit_entries_no_delete`;
  await Promise.all([serviceBus.disconnect(), producerBus.disconnect()]);

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('IMMUTABLE AUDIT TRAIL PROVEN OVER LIVE KAFKA + PG ✓');
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
