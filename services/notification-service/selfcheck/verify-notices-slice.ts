// ══════════════════════════════════════════════════════════════════
// notification-service — Withdrawal notice self-check (ADR-022)
//
// The citizen-notice seam proven end-to-end on ONE in-memory bus against
// live PG, with the REAL contact resolver (ADR-021) and the REAL
// auto-withdrawal projector (ADR-017):
//   1. ACCEPTED event → projector retires the sibling (real DB write) →
//      ONE APPLICATION_WITHDRAWN summary → consumer → ONE SMS to the
//      decrypted stored phone; body names winner + retired agencies and
//      carries NO PII and NO opaque UUIDs; WITHDRAWAL_NOTICE_NOTIFIED
//      audit records DELIVERED.
//   2. Redelivered acceptance → empty sweep → no summary → NO second SMS.
//   3. Citizen without a stored contact → PENDING_NO_CONTACT audit,
//      nothing sent (delivery degrades honestly, never throws).
//   4. Channel failure → FAILED recorded truthfully.
//   5. The notice NEVER touches application state (no NOTIFICATION_
//      DELIVERED event; WITHDRAWN rows stay WITHDRAWN).
//   6. No raw phone / NID hash on any bus event.
//
//   Run via scripts/run-selfchecks.sh, or standalone:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/notification-service/selfcheck/verify-notices-slice.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { generateKeyPairSync } from 'node:crypto';

// Env BEFORE the dynamic imports so every config loads with dev defaults.
process.env['DATABASE_URL'] ??= 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db';
process.env['PII_ENCRYPTION_KEY'] ??= 'dev_pii_encryption_key_min_32_chars_ok!!';
if (process.env['AUTH_JWT_PUBLIC_KEY_B64'] === undefined) {
  const k = generateKeyPairSync('ed25519');
  process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
    k.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    'utf8',
  ).toString('base64');
}

const { InMemoryEventBus } = await import('@usrp/shared-events');
const { sql } = await import('@usrp/shared-database');
const { LogSmsChannel } = await import('@usrp/shared-sms');
const {
  DeliverWithdrawalNoticeService,
  PgContactResolver,
  startApplicationWithdrawnConsumer,
} = await import('../src/index.js');
const { createApplicationService, loadApplicationConfig, startApplicationAcceptedConsumer } =
  await import('@usrp/application-service');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const PII_KEY = process.env['PII_ENCRYPTION_KEY'] ?? '';

// ── Deterministic fixtures (ad220000 — unique to this proof) ──────
const APPLICANT = 'ad220000-0000-4000-8000-000000000001'; // has a stored contact
const APPLICANT_NC = 'ad220000-0000-4000-8000-000000000002'; // no contact on file
const NID_HASH = 'ad22ad22'.repeat(8); // 64 hex
const NID_HASH_NC = 'ad22bd22'.repeat(8);
const PHONE = '+250788ad220001'; // fake but distinctive; only the resolver ever sees it
const RDF_CAMPAIGN = 'ad220000-0000-4000-8000-0000000000c1';
const RNP_CAMPAIGN = 'ad220000-0000-4000-8000-0000000000c2';
const RDF_WIN = 'ad220000-0000-4000-8000-00000000a001'; // ACCEPTED winner
const RNP_SIB = 'ad220000-0000-4000-8000-00000000b001'; // SUBMITTED sibling → WITHDRAWN
const CORRELATION = 'ad220000-0000-4000-8000-000000000e01';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const schema of ['rdf_ops', 'rnp_ops'] as const) {
      await tx`
        DELETE FROM ${tx(schema)}.application_status_history
        WHERE application_id IN (SELECT id FROM ${tx(schema)}.applications
                                 WHERE applicant_id IN ${tx([APPLICANT, APPLICANT_NC])})`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE applicant_id IN ${tx([APPLICANT, APPLICANT_NC])}`;
    }
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([RDF_CAMPAIGN, RNP_CAMPAIGN])}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx([APPLICANT, APPLICANT_NC])}`;
  });
}

async function seed(): Promise<void> {
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status, encrypted_phone_number)
    VALUES
      (${APPLICANT}, ${NID_HASH}, 'x', 'x', 'x', 'x', 'MALE', 'WEB',
       'VERIFIED'::public_core.identity_verification_status,
       pgp_sym_encrypt(${PHONE}, ${PII_KEY})),
      (${APPLICANT_NC}, ${NID_HASH_NC}, 'x', 'x', 'x', 'x', 'FEMALE', 'WEB',
       'VERIFIED'::public_core.identity_verification_status, NULL)`;
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${RDF_CAMPAIGN}, 'Notices RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
      (${RNP_CAMPAIGN}, 'Notices RNP', 'RNP', 'REGISTRATION_OPEN', '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RDF_WIN}, 'RDF-98101', ${APPLICANT}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT',
            'ACCEPTED'::rdf_ops.application_status)`;
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RNP_SIB}, 'RNP-98101', ${APPLICANT}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
            'SUBMITTED'::rnp_ops.application_status)`;
}

async function statusOf(schema: 'rdf_ops' | 'rnp_ops', id: string): Promise<string> {
  const rows = await admin<{ status: string }[]>`
    SELECT status::text AS status FROM ${admin(schema)}.applications WHERE id = ${id}`;
  return rows[0]?.status ?? '<missing>';
}

async function main(): Promise<void> {
  await cleanup();
  await seed();

  // ── Composition: ONE bus hosts the real projector AND the real notice ──
  const bus = new InMemoryEventBus();
  const app = createApplicationService(loadApplicationConfig(), bus);
  await startApplicationAcceptedConsumer(bus, app.withdrawalProjector);
  const smsChannel = new LogSmsChannel();
  const resolver = new PgContactResolver(PII_KEY);
  const notice = new DeliverWithdrawalNoticeService({ resolver, channel: smsChannel, eventBus: bus });
  await startApplicationWithdrawnConsumer(bus, notice);

  const acceptedEvent = {
    eventId: 'ad220000-0000-4000-8000-00000000ee01',
    eventVersion: '1.0' as const,
    eventType: 'APPLICATION_ACCEPTED' as const,
    occurredAt: new Date().toISOString(),
    correlationId: CORRELATION,
    causationId: CORRELATION,
    applicationId: RDF_WIN,
    applicantId: APPLICANT,
    agency: 'RDF' as const,
    campaignId: RDF_CAMPAIGN,
    category: 'GENERAL_ENLISTMENT' as const,
  };

  try {
    console.log('\n── 1. Acceptance → withdrawal → ONE notice to the stored contact ──');
    await bus.publish(acceptedEvent);

    check('sibling actually WITHDRAWN (real projector wrote)', (await statusOf('rnp_ops', RNP_SIB)) === 'WITHDRAWN');
    check('exactly ONE SMS sent', smsChannel.sent.length === 1, String(smsChannel.sent.length));
    const sent = smsChannel.sent[0];
    check('sent to the DECRYPTED stored phone', sent?.destination === PHONE);
    check('body names the accepting agency', (sent?.body ?? '').includes('accepted by RDF'));
    check('body names the retired agency + count', (sent?.body ?? '').includes('1 other') && (sent?.body ?? '').includes('RNP'));
    check('body carries NO UUIDs / NID hash / phone',
      !/[0-9a-f]{8}-[0-9a-f]{4}/.test(sent?.body ?? '') &&
        !(sent?.body ?? '').includes(NID_HASH) &&
        !(sent?.body ?? '').includes(PHONE));

    const noticeAudits = bus.published.filter(
      (e) => e.eventType === 'AUDIT_ENTRY' && (e as { action?: string }).action === 'WITHDRAWAL_NOTICE_NOTIFIED',
    ) as Array<{ entityId: string; agency: string; metadata?: Record<string, unknown> }>;
    check('ONE WITHDRAWAL_NOTICE_NOTIFIED audit', noticeAudits.length === 1, String(noticeAudits.length));
    check('audit: citizen entity, winner agency, DELIVERED, count 1',
      noticeAudits[0]?.entityId === APPLICANT &&
        noticeAudits[0]?.agency === 'RDF' &&
        noticeAudits[0]?.metadata?.['deliveryStatus'] === 'DELIVERED' &&
        noticeAudits[0]?.metadata?.['withdrawnCount'] === 1,
      JSON.stringify(noticeAudits[0] ?? {}));

    console.log('\n── 2. Notice never touches application state ──');
    check('no NOTIFICATION_DELIVERED emitted for a notice',
      bus.published.every((e) => e.eventType !== 'NOTIFICATION_DELIVERED'));
    check('withdrawn row still WITHDRAWN', (await statusOf('rnp_ops', RNP_SIB)) === 'WITHDRAWN');

    console.log('\n── 3. Redelivered acceptance → empty sweep → NO duplicate SMS ──');
    await bus.publish(acceptedEvent);
    check('still exactly ONE SMS', smsChannel.sent.length === 1, String(smsChannel.sent.length));

    console.log('\n── 4. No stored contact → PENDING_NO_CONTACT, nothing sent ──');
    const ncStatus = await notice.deliver({
      applicantId: APPLICANT_NC,
      acceptedApplicationId: RDF_WIN,
      acceptedByAgency: 'RDF',
      withdrawn: [{ applicationId: RNP_SIB, agency: 'RNP' }],
      context: { correlationId: CORRELATION, causationId: CORRELATION },
    });
    check('records PENDING_NO_CONTACT', ncStatus === 'PENDING_NO_CONTACT', ncStatus);
    check('channel sent nothing new', smsChannel.sent.length === 1);

    console.log('\n── 5. Channel failure → FAILED recorded truthfully ──');
    const failingChannel = { send: async (): Promise<'FAILED'> => 'FAILED' };
    const failing = new DeliverWithdrawalNoticeService({ resolver, channel: failingChannel, eventBus: bus });
    const failedStatus = await failing.deliver({
      applicantId: APPLICANT,
      acceptedApplicationId: RDF_WIN,
      acceptedByAgency: 'RDF',
      withdrawn: [{ applicationId: RNP_SIB, agency: 'RNP' }],
      context: { correlationId: CORRELATION, causationId: CORRELATION },
    });
    check('records FAILED', failedStatus === 'FAILED', failedStatus);

    console.log('\n── 6. No leaks on the bus ──');
    const allEvents = JSON.stringify(bus.published);
    check('no raw phone on any event', !allEvents.includes(PHONE));
    check('no NID hash on any event', !allEvents.includes(NID_HASH));
  } finally {
    await cleanup();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('WITHDRAWAL NOTICE PROVEN (live, ADR-022) — acceptance → sweep → one citizen SMS ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

main()
  .then(async () => {
    await Promise.all([sql.end(), admin.end()]);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    console.error('\nSELF-CHECK CRASHED:', err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    await Promise.all([sql.end(), admin.end()]);
    process.exit(1);
  });
