// ══════════════════════════════════════════════════════════════════
// notification-service — Live delivery + lifecycle-advance self-check
//
// Proves the invitation loop end-to-end against live PG (InMemoryEventBus so we
// can inspect emitted events, then a wired application-service projection):
//   • a resolvable contact → LogSmsChannel delivers, NOTIFICATION_DELIVERED emitted
//     with deliveryStatus DELIVERED, body carries the signed QR, no PII leak;
//   • a null-resolving contact → PENDING_NO_CONTACT (no send);
//   • application-service consumes NOTIFICATION_DELIVERED and advances
//     SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED (append-only history), idempotent
//     on redelivery, and refuses to advance a row that is not SLOT_ASSIGNED;
//   • the production PgContactResolver (ADR-021) decrypts a stored contact
//     from live PG, and returns null for unknown / contact-less / erased rows.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   npx tsx services/notification-service/selfcheck/verify-notification-slice.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus, newEnvelope } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import type { SlotAssignedEvent } from '@usrp/shared-types';
import {
  DeliverInvitationService,
  LogSmsChannel,
  PgContactResolver,
  buildInvitationBody,
  type ContactResolver,
  type ResolvedContact,
} from '../src/index.js';
import {
  createApplicationService,
  loadApplicationConfig,
} from '@usrp/application-service';

// application-service config now requires an auth verify key even though this
// proof drives the projector directly (no HTTP) — provide an ephemeral one.
import { generateKeyPairSync } from 'node:crypto';
if (process.env['AUTH_JWT_PUBLIC_KEY_B64'] === undefined) {
  const k = generateKeyPairSync('ed25519');
  process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
    k.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    'utf8',
  ).toString('base64');
}

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const APPLICANT_ID = '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b';
const APP_ID = '8a111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = '8c111111-1111-4111-8111-111111111111';
const CODE = 'RDF-98001';
const QR_TOKEN = 'USRP-SLOT.v1.eyJmYWtlIjoidG9rZW4ifQ.c2ln';
const CORRELATION_ID = '81111111-1111-4111-8111-111111111111';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

class StaticContactResolver implements ContactResolver {
  constructor(private readonly contact: ResolvedContact | null) {}
  async resolve(): Promise<ResolvedContact | null> {
    return this.contact;
  }
}

function slotEvent(): SlotAssignedEvent {
  return {
    ...newEnvelope({ correlationId: CORRELATION_ID, causationId: CORRELATION_ID }),
    eventType: 'SLOT_ASSIGNED',
    applicantId: APPLICANT_ID,
    applicationId: APP_ID,
    agency: 'RDF',
    campaignId: CAMPAIGN_ID,
    slotId: '8d111111-1111-4111-8111-111111111111',
    district: 'GASABO',
    venueName: 'ULK Stadium',
    examDate: '2026-09-10',
    reportingTimeHour: 7,
    qrInvitationCode: CODE,
    qrSignedToken: QR_TOKEN,
  } as SlotAssignedEvent;
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id = ${APP_ID}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id = ${APP_ID}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN_ID}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
  });
}

async function seedSlotAssignedRow(): Promise<void> {
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender, registration_channel, identity_status)
    VALUES (${APPLICANT_ID}, ${'8b'.repeat(32)}, 'x','x','x','x','MALE','WEB','VERIFIED'::public_core.identity_verification_status)`;
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at, examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES (${CAMPAIGN_ID}, 'Notif RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
            now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;
  // A row already at SLOT_ASSIGNED (the notification advances it from here).
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${APP_ID}, ${CODE}, ${APPLICANT_ID}, ${CAMPAIGN_ID}, 'GENERAL_ENLISTMENT', 'SLOT_ASSIGNED')`;
}

async function statusOf(): Promise<string> {
  const rows = await admin<{ status: string; sms_notification_status: string | null }[]>`
    SELECT status::text, sms_notification_status FROM rdf_ops.applications WHERE id = ${APP_ID}`;
  return rows[0]?.status ?? 'MISSING';
}

async function main(): Promise<void> {
  console.log('\n── 1. Delivery with a resolvable contact → DELIVERED ─────────');
  const bus = new InMemoryEventBus();
  const channel = new LogSmsChannel();
  const deliver = new DeliverInvitationService({
    resolver: new StaticContactResolver({ channel: 'SMS', destination: '+250780000000' }),
    channel,
    eventBus: bus,
  });
  const ev = slotEvent();
  const out = await deliver.deliver({
    applicantId: ev.applicantId,
    applicationId: ev.applicationId,
    agency: ev.agency,
    content: { venueName: ev.venueName, examDate: ev.examDate, reportingTimeHour: ev.reportingTimeHour, qrSignedToken: ev.qrSignedToken },
    context: { correlationId: ev.correlationId, causationId: ev.eventId },
  });
  check('outcome DELIVERED', out.deliveryStatus === 'DELIVERED', out.deliveryStatus);
  check('channel actually sent one message', channel.sent.length === 1, String(channel.sent.length));
  check('sent body carries the signed QR token', (channel.sent[0]?.body ?? '').includes(QR_TOKEN));
  const delivered = bus.published.find((e) => e.eventType === 'NOTIFICATION_DELIVERED');
  const audit = bus.published.find((e) => e.eventType === 'AUDIT_ENTRY');
  check('NOTIFICATION_DELIVERED emitted', delivered !== undefined);
  check('event.deliveryStatus DELIVERED', asRecord(delivered)['deliveryStatus'] === 'DELIVERED');
  check('event.correlationId preserved', asRecord(delivered)['correlationId'] === CORRELATION_ID);
  check('AUDIT_ENTRY emitted', audit !== undefined);
  check('no destination (PII) on the event', !JSON.stringify(delivered).includes('+250780000000'));
  check('no QR token on the outcome event', !JSON.stringify(delivered).includes(QR_TOKEN));

  console.log('\n── 2. Production resolver (no stored contact) → PENDING ──────');
  const bus2 = new InMemoryEventBus();
  const deliver2 = new DeliverInvitationService({
    resolver: new StaticContactResolver(null),
    channel: new LogSmsChannel(),
    eventBus: bus2,
  });
  const out2 = await deliver2.deliver({
    applicantId: ev.applicantId, applicationId: ev.applicationId, agency: ev.agency,
    content: { venueName: ev.venueName, examDate: ev.examDate, reportingTimeHour: ev.reportingTimeHour, qrSignedToken: ev.qrSignedToken },
    context: { correlationId: ev.correlationId, causationId: ev.eventId },
  });
  check('outcome PENDING_NO_CONTACT (nothing to deliver to)', out2.deliveryStatus === 'PENDING_NO_CONTACT', out2.deliveryStatus);

  console.log('\n── 3. application-service projection advances the lifecycle ──');
  const appConfig = loadApplicationConfig();
  const projBus = new InMemoryEventBus();
  const app = createApplicationService(appConfig, projBus);
  await cleanup();
  await seedSlotAssignedRow();
  check('seeded row is SLOT_ASSIGNED', (await statusOf()) === 'SLOT_ASSIGNED');

  const proj = await app.notificationProjector.project({
    result: { applicationId: APP_ID, agency: 'RDF', deliveryStatus: 'DELIVERED', correlationId: CORRELATION_ID },
    agency: 'RDF',
    context: { correlationId: CORRELATION_ID, causationId: CORRELATION_ID },
  });
  check('projection APPLIED', proj.kind === 'APPLIED', proj.kind);
  check('row advanced to PHYSICAL_TEST_SCHEDULED', (await statusOf()) === 'PHYSICAL_TEST_SCHEDULED');
  const hist = await admin<{ from_status: string; to_status: string }[]>`
    SELECT from_status::text, to_status::text FROM rdf_ops.application_status_history
    WHERE application_id = ${APP_ID} AND to_status = 'PHYSICAL_TEST_SCHEDULED'`;
  check('history row SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED', hist[0]?.from_status === 'SLOT_ASSIGNED' && hist[0]?.to_status === 'PHYSICAL_TEST_SCHEDULED');
  check('advance emitted an AUDIT_ENTRY', projBus.published.some((e) => e.eventType === 'AUDIT_ENTRY'));

  console.log('\n── 4. Idempotent redelivery + hold-safety ───────────────────');
  const again = await app.notificationProjector.project({
    result: { applicationId: APP_ID, agency: 'RDF', deliveryStatus: 'DELIVERED', correlationId: CORRELATION_ID },
    agency: 'RDF', context: { correlationId: CORRELATION_ID, causationId: CORRELATION_ID },
  });
  check('redelivery is NO_CHANGE (idempotent)', again.kind === 'NO_CHANGE', again.kind);
  const histCount = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rdf_ops.application_status_history
    WHERE application_id = ${APP_ID} AND to_status = 'PHYSICAL_TEST_SCHEDULED'`;
  check('no duplicate history row on redelivery', histCount[0]?.n === 1, String(histCount[0]?.n));
  // A row not yet SLOT_ASSIGNED cannot be advanced by a notification.
  await admin`UPDATE rdf_ops.applications SET status = 'CRIMINAL_CLEARANCE' WHERE id = ${APP_ID}`;
  const held = await app.notificationProjector.project({
    result: { applicationId: APP_ID, agency: 'RDF', deliveryStatus: 'DELIVERED', correlationId: CORRELATION_ID },
    agency: 'RDF', context: { correlationId: CORRELATION_ID, causationId: CORRELATION_ID },
  });
  check('pre-slot row → NOT_APPLICABLE (hold-safe)', held.kind === 'NOT_APPLICABLE', held.kind);

  console.log('\n── 5. Rendering is PII-free ─────────────────────────────────');
  const body = buildInvitationBody({ venueName: ev.venueName, examDate: ev.examDate, reportingTimeHour: ev.reportingTimeHour, qrSignedToken: ev.qrSignedToken });
  check('body has venue/date + QR, no applicant id', body.includes('ULK Stadium') && body.includes(QR_TOKEN) && !body.includes(APPLICANT_ID));

  console.log('\n── 6. PgContactResolver against live PG (ADR-021) ───────────');
  const encryptionKey =
    process.env['PII_ENCRYPTION_KEY'] ?? 'dev_pii_encryption_key_min_32_chars_ok!!';
  const resolver = new PgContactResolver(encryptionKey);
  const STORED_PHONE = '072-000-X555';
  await admin`
    UPDATE public_core.applicant_identities
    SET encrypted_phone_number = pgp_sym_encrypt(${STORED_PHONE}, ${encryptionKey})
    WHERE id = ${APPLICANT_ID}`;
  const resolved = await resolver.resolve(APPLICANT_ID);
  check('stored contact resolves as SMS', resolved?.channel === 'SMS');
  check('decrypted destination matches what was stored', resolved?.destination === STORED_PHONE);
  const unknown = await resolver.resolve('8b8b8b8b-0000-4000-8000-00000000dead');
  check('unknown applicant → null (no throw)', unknown === null);
  await admin`
    UPDATE public_core.applicant_identities
    SET encrypted_phone_number = NULL WHERE id = ${APPLICANT_ID}`;
  check('no stored contact → null', (await resolver.resolve(APPLICANT_ID)) === null);
  // First tombstoning UPDATE passes the rls/0014 freeze (OLD.deleted_at IS NULL).
  await admin`
    UPDATE public_core.applicant_identities
    SET encrypted_phone_number = pgp_sym_encrypt(${STORED_PHONE}, ${encryptionKey}), deleted_at = now()
    WHERE id = ${APPLICANT_ID}`;
  check('erased row → null even with residual ciphertext', (await resolver.resolve(APPLICANT_ID)) === null);

  await cleanup();
  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('NOTIFICATION DELIVERY + LIFECYCLE ADVANCE PROVEN ✓');
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
