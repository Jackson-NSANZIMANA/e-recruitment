// ══════════════════════════════════════════════════════════════════
// notification-service — Contact capture → REAL delivery self-check (ADR-021)
//
// The slice's headline claim, proven end-to-end against live PG + the NIDA
// mock, with ZERO HTTP servers (in-proc factories only):
//   1. CAPTURE  — OTP request/verify for a NIDA citizen; the registered phone
//      lands pgcrypto-encrypted in encrypted_phone_number (rls/0018), and
//      decrypts back to the mock's phone; ciphertext ≠ plaintext.
//   2. RESOLVE  — PgContactResolver decrypts it; unknown applicant → null.
//   3. DELIVER  — DeliverInvitationService with the REAL resolver → DELIVERED;
//      the channel saw the true destination; body carries the QR token.
//   4. PROJECT  — application-service advances SLOT_ASSIGNED →
//      PHYSICAL_TEST_SCHEDULED and sms_notification_status records DELIVERED.
//   5. ERASE    — erasure destroys the contact; resolver → null; a fresh
//      delivery records PENDING_NO_CONTACT and sends NOTHING.
//   6. NO LEAKS — no bus event carries the phone, the OTP code, or the hash.
//
//   Run via scripts/run-selfchecks.sh, or standalone:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/notification-service/selfcheck/verify-contact-delivery-slice.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { generateKeyPairSync } from 'node:crypto';

// Env BEFORE the dynamic imports so every config loads with dev defaults.
process.env['DATABASE_URL'] ??= 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db';
process.env['NIDA_BASE_URL'] ??= 'http://localhost:3100';
process.env['NIDA_HMAC_SECRET'] ??= 'dev_nida_hmac_secret_min_32_chars_ok!';
process.env['NATIONAL_ID_HMAC_KEY'] ??= 'dev_national_id_hmac_key_min_32_chars!';
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
const { hashNationalId } = await import('@usrp/shared-security');
const { LogSmsChannel } = await import('@usrp/shared-sms');
const { DeliverInvitationService, PgContactResolver } = await import('../src/index.js');
const { createApplicationService, loadApplicationConfig } = await import('@usrp/application-service');
const {
  createApplicantAuthService,
  createEraseIdentityService,
  createIdentityService,
  loadIdentityConfig,
} = await import('@usrp/identity-service');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Fixtures (ad210000) ─────────────────────────────────────────────
const CITIZEN_NID = '1200380123456789'; // UWIMANA Jean Pierre — NIDA mock, WITH a registered phone
const MOCK_PHONE_FRAGMENT = '380-X789'; // distinctive tail of the mock's registered phone
const CAMPAIGN_ID = 'ad210000-0000-4000-8000-0000000000c1';
const APP_ID = 'ad210000-0000-4000-8000-00000000a001';
const CODE = 'RDF-99101';
const CORRELATION_ID = 'ad210000-0000-4000-8000-000000000e01';
const OFFICER_ID = 'ad210000-0000-4000-8000-00000000ff01';
const UNKNOWN_APPLICANT = 'ad210000-0000-4000-8000-00000000dead';
const QR_TOKEN = 'USRP-SLOT.v1.eyJhZDIxIjoidG9rZW4ifQ.c2ln';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const idConfig = loadIdentityConfig();
const CITIZEN_HASH = hashNationalId(CITIZEN_NID, idConfig.security.nationalIdHmacKey);

// The citizen's identity row id — captured from the real verify use case.
let applicantId = '';

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id = ${APP_ID}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id = ${APP_ID}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN_ID}`;
    // By hash (live rows from crashed runs share this NID) AND by captured id
    // (this run's row — its hash rotates on erasure, so the id is the handle).
    const ids = [CITIZEN_HASH, applicantId || CITIZEN_HASH];
    await tx`DELETE FROM public_core.applicant_otp_challenges
             WHERE applicant_id IN (SELECT id FROM public_core.applicant_identities
                                    WHERE national_id_hash = ANY(${tx.array(ids)}) OR id::text = ${applicantId || '-'})`;
    await tx`DELETE FROM public_core.applicant_sessions
             WHERE applicant_id IN (SELECT id FROM public_core.applicant_identities
                                    WHERE national_id_hash = ANY(${tx.array(ids)}) OR id::text = ${applicantId || '-'})`;
    await tx`DELETE FROM public_core.applicant_identities
             WHERE national_id_hash = ANY(${tx.array(ids)}) OR id::text = ${applicantId || '-'}`;
  });
}

async function seedApplicationAtSlotAssigned(): Promise<void> {
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at, examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES (${CAMPAIGN_ID}, 'Contact RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
            now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${APP_ID}, ${CODE}, ${applicantId}, ${CAMPAIGN_ID}, 'GENERAL_ENLISTMENT', 'SLOT_ASSIGNED')`;
}

async function contactRow(): Promise<{ ciphertext: string | null; phone: string | null }> {
  const rows = await admin<{ ciphertext: string | null; phone: string | null }[]>`
    SELECT encrypted_phone_number AS ciphertext,
           CASE WHEN encrypted_phone_number IS NULL THEN NULL
                ELSE pgp_sym_decrypt(encrypted_phone_number::bytea, ${idConfig.security.encryptionKey})
           END AS phone
    FROM public_core.applicant_identities WHERE id = ${applicantId}`;
  return rows[0] ?? { ciphertext: null, phone: null };
}

async function main(): Promise<void> {
  await cleanup();

  console.log('\n── 1. CAPTURE: OTP login stores the encrypted contact ────────');
  const idBus = new InMemoryEventBus();
  const verified = await createIdentityService(idConfig, idBus).verify({
    rawNationalId: CITIZEN_NID,
    registrationChannel: 'WEB',
  });
  check(
    'citizen identity exists (CREATED | ALREADY_EXISTS)',
    verified.kind === 'CREATED' || verified.kind === 'ALREADY_EXISTS',
    verified.kind,
  );
  if (verified.kind !== 'CREATED' && verified.kind !== 'ALREADY_EXISTS') throw new Error('no identity');
  applicantId = verified.applicantId;

  const otpSms = new LogSmsChannel();
  const applicantAuth = createApplicantAuthService(idConfig, idBus, otpSms);
  const challenged = await applicantAuth.requestOtp({ rawNationalId: CITIZEN_NID, channel: 'WEB' });
  check('OTP requested → CHALLENGED', challenged.kind === 'CHALLENGED');
  const otpCode = (otpSms.sent[otpSms.sent.length - 1]?.body ?? '').match(/\b\d{6}\b/)?.[0] ?? '';
  check('OTP SMS captured (6-digit code, to the NIDA phone)',
    otpCode.length === 6 && (otpSms.sent[0]?.destination.includes(MOCK_PHONE_FRAGMENT) ?? false));

  const authed = await applicantAuth.verifyOtp({ rawNationalId: CITIZEN_NID, otp: otpCode, channel: 'WEB' });
  check('OTP verified → AUTHENTICATED', authed.kind === 'AUTHENTICATED', authed.kind);

  const captured = await contactRow();
  check('encrypted_phone_number captured', captured.ciphertext !== null);
  check('ciphertext decrypts to the NIDA-registered phone',
    (captured.phone ?? '').includes(MOCK_PHONE_FRAGMENT), captured.phone ?? 'null');
  check('stored value is ciphertext, not plaintext',
    !(captured.ciphertext ?? '').includes(MOCK_PHONE_FRAGMENT));

  console.log('\n── 2. RESOLVE: PgContactResolver decrypts the stored contact ─');
  const resolver = new PgContactResolver(idConfig.security.encryptionKey);
  const contact = await resolver.resolve(applicantId);
  check('resolves as SMS to the captured phone',
    contact?.channel === 'SMS' && contact.destination.includes(MOCK_PHONE_FRAGMENT));
  check('unknown applicant → null (no throw)', (await resolver.resolve(UNKNOWN_APPLICANT)) === null);

  console.log('\n── 3. DELIVER: real resolver + channel → DELIVERED ───────────');
  await seedApplicationAtSlotAssigned();
  const deliveryBus = new InMemoryEventBus();
  const deliverySms = new LogSmsChannel();
  const deliver = new DeliverInvitationService({ resolver, channel: deliverySms, eventBus: deliveryBus });
  const command = {
    applicantId,
    applicationId: APP_ID,
    agency: 'RDF' as const,
    content: { venueName: 'ULK Stadium', examDate: '2026-09-10', reportingTimeHour: 7, qrSignedToken: QR_TOKEN },
    context: { correlationId: CORRELATION_ID, causationId: CORRELATION_ID },
  };
  const outcome = await deliver.deliver(command);
  check('outcome DELIVERED (a real send happened)', outcome.deliveryStatus === 'DELIVERED', outcome.deliveryStatus);
  check('channel saw the true destination',
    deliverySms.sent.length === 1 && (deliverySms.sent[0]?.destination.includes(MOCK_PHONE_FRAGMENT) ?? false));
  check('invitation body carries the signed QR token', (deliverySms.sent[0]?.body ?? '').includes(QR_TOKEN));
  const deliveredEvent = deliveryBus.published.find((e) => e.eventType === 'NOTIFICATION_DELIVERED');
  check('NOTIFICATION_DELIVERED emitted with deliveryStatus DELIVERED',
    (deliveredEvent as { deliveryStatus?: string } | undefined)?.deliveryStatus === 'DELIVERED');

  console.log('\n── 4. PROJECT: lifecycle advance + recorded SMS status ───────');
  const app = createApplicationService(loadApplicationConfig(), new InMemoryEventBus());
  const projected = await app.notificationProjector.project({
    result: { applicationId: APP_ID, agency: 'RDF', deliveryStatus: 'DELIVERED', correlationId: CORRELATION_ID },
    agency: 'RDF',
    context: { correlationId: CORRELATION_ID, causationId: CORRELATION_ID },
  });
  check('projection APPLIED', projected.kind === 'APPLIED', projected.kind);
  const appRow = await admin<{ status: string; sms: string | null }[]>`
    SELECT status::text, sms_notification_status AS sms FROM rdf_ops.applications WHERE id = ${APP_ID}`;
  check('row advanced to PHYSICAL_TEST_SCHEDULED', appRow[0]?.status === 'PHYSICAL_TEST_SCHEDULED');
  check('sms_notification_status records DELIVERED', appRow[0]?.sms === 'DELIVERED', appRow[0]?.sms ?? 'null');

  console.log('\n── 5. ERASE: the contact dies; delivery degrades honestly ────');
  await admin`UPDATE rdf_ops.applications SET status = 'REJECTED' WHERE id = ${APP_ID}`;
  const erased = await createEraseIdentityService(idConfig, idBus).erase(
    { applicantId },
    { kind: 'officer', subjectId: OFFICER_ID, agency: 'RDF', roles: [] },
  );
  check('erasure executes (all-terminal gate open)', erased.kind === 'ERASED', erased.kind);
  check('encrypted_phone_number destroyed', (await contactRow()).ciphertext === null);
  check('resolver → null after erasure', (await resolver.resolve(applicantId)) === null);
  const afterErasure = await deliver.deliver(command);
  check('fresh delivery → PENDING_NO_CONTACT', afterErasure.deliveryStatus === 'PENDING_NO_CONTACT');
  check('…and NOTHING more was sent', deliverySms.sent.length === 1, String(deliverySms.sent.length));

  console.log('\n── 6. NO LEAKS on any bus ─────────────────────────────────────');
  const allEvents = JSON.stringify([...idBus.published, ...deliveryBus.published]);
  check('no raw phone on any event', !allEvents.includes(MOCK_PHONE_FRAGMENT));
  check('no OTP code on any event', otpCode === '' || !allEvents.includes(otpCode));
  check('no NID hash of the citizen on delivery events',
    !JSON.stringify(deliveryBus.published).includes(CITIZEN_HASH));

  await cleanup();
  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('CONTACT CAPTURE → REAL DELIVERY PROVEN (live, ADR-021) ✓');
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
