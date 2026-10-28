// ══════════════════════════════════════════════════════════════════
// background-vetting-service — LIVE proof of the Irembo clearance flow
// (ADR-048 §2.3-2.4, rls/0040). Real Postgres, the irembo-certificates
// simulator in-process, an in-memory bus. Proves:
//
//   1. every clearance persona lands in its outcome THROUGH the real identity
//      reader (pgcrypto) and the real SECURITY DEFINER command function;
//   2. the append-only table: UPDATE / DELETE / TRUNCATE refused for every role
//      including the table owner; direct INSERT refused for the service role,
//      the officer role and the system service;
//   3. the command function: refuses a caller that is not usrp_vetting_service,
//      an unknown application, is idempotent for a redelivery;
//   4. no name and no date of birth anywhere in the stored row, the reference
//      held as HMAC + last 4; the binding column refuses a value;
//   5. isolation: an RNP officer cannot read an RDF application's rows; the
//      officer of the owning agency can;
//   6. an outage is not a verdict (PENDING recorded, nothing emitted).
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   ADMIN_DATABASE_URL='postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db' \
//   PII_ENCRYPTION_KEY=... pnpm --filter @usrp/background-vetting-service selfcheck:clearance
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from '@usrp/shared-database';
import { InMemoryEventBus } from '@usrp/shared-events';
import { createSandboxServer, DEFAULT_PROFILES, Population, silentLog, DEV_G2G_CLIENT_TOKEN } from '@usrp/g2g-sandbox';
import {
  ClearanceRegistryUnavailableError,
  HttpIremboCertificateTransport,
  IremboCertificateGateway,
  PgApplicantIdentityReader,
  PgClearanceVerificationRepository,
  VerifyClearanceCertificateService,
} from '../src/index.js';

const ADMIN_URL = process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const PII_KEY = process.env['PII_ENCRYPTION_KEY'] ?? 'dev_pii_encryption_key_min_32_chars_ok!!';
const HMAC_KEY = 'selfcheck-clearance-reference-hmac-key-32c';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`); }
}
async function refused(label: string, fn: () => Promise<unknown>, needle = /./): Promise<void> {
  try { await fn(); check(label, false, 'was permitted'); } catch (e) { check(label, needle.test(String((e as Error).message) + String((e as { cause?: Error }).cause?.message ?? ''))); }
}

const REFERENCE = new Date(Date.UTC(2026, 9, 25));
const TODAY = '2026-10-25';
const pop = new Population({ seed: 3, size: 5, referenceDate: REFERENCE });
const POLICY = { allowedTypes: new Set(['SANDBOX_PLACEHOLDER_CRIMINAL_NO_RECORD', 'SANDBOX_PLACEHOLDER_CRIMINAL_RECORD_EXTRACT']), noRecordTypes: new Set(['SANDBOX_PLACEHOLDER_CRIMINAL_NO_RECORD']), validityDays: 90 };

const PERSONAS = ['P-CLEARANCE-VALID', 'P-CLEARANCE-CONVICTION', 'P-CLEARANCE-WRONG-TYPE', 'P-CLEARANCE-EXPIRED', 'P-CLEARANCE-NAME-MISMATCH', 'P-CLEARANCE-DOB-MISMATCH', 'P-CLEARANCE-NAME-PARTIAL', 'P-CLEARANCE-503'] as const;
const EXPECT: Record<(typeof PERSONAS)[number], string> = {
  'P-CLEARANCE-VALID': 'CLEARED',
  'P-CLEARANCE-CONVICTION': 'REVIEW:CLEARANCE_CONTENT_REVIEW',
  'P-CLEARANCE-WRONG-TYPE': 'CORRECTION_NEEDED:CERTIFICATE_WRONG_TYPE',
  'P-CLEARANCE-EXPIRED': 'CORRECTION_NEEDED:CERTIFICATE_EXPIRED',
  'P-CLEARANCE-NAME-MISMATCH': 'CORRECTION_NEEDED:CERTIFICATE_NOT_BOUND',
  'P-CLEARANCE-DOB-MISMATCH': 'CORRECTION_NEEDED:CERTIFICATE_NOT_BOUND',
  'P-CLEARANCE-NAME-PARTIAL': 'REVIEW:IDENTITY_NAME_PARTIAL',
  'P-CLEARANCE-503': 'PENDING:REGISTRY_UNAVAILABLE',
};

const applicantOf = new Map<string, string>();
const applicationOf = new Map<string, string>();

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const key of PERSONAS) {
      const c = pop.persona(key);
      const applicantId = randomUUID();
      const applicationId = randomUUID();
      applicantOf.set(key, applicantId);
      applicationOf.set(key, applicationId);
      await tx`
        INSERT INTO public_core.applicant_identities
          (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth, encrypted_home_district, encrypted_home_province,
           gender, registration_channel, identity_status, encrypted_national_id_hint)
        VALUES (${applicantId}, ${randomUUID().replaceAll('-', '').repeat(2)},
                pgp_sym_encrypt(${`${c.surname} ${c.forename}`}, ${PII_KEY}), pgp_sym_encrypt(${c.dateOfBirth}, ${PII_KEY}),
                pgp_sym_encrypt('GASABO', ${PII_KEY}), pgp_sym_encrypt('KIGALI_CITY', ${PII_KEY}),
                ${c.sex}, 'WEB', 'VERIFIED'::public_core.identity_verification_status,
                pgp_sym_encrypt(${`${c.nid.slice(0, 4)}${c.nid.slice(12)}`}, ${PII_KEY}))`;
      await tx`
        INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category)
        VALUES (${applicationId}, ${`CLR-${applicationId.slice(0, 8)}`}, ${applicantId}, ${randomUUID()}, 'GENERAL_ENLISTMENT')`;
    }
  });
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    const apps = [...applicationOf.values()];
    const applicants = [...applicantOf.values()];
    if (apps.length === 0) return;
    await tx`DELETE FROM rdf_ops.clearance_certificate_verifications WHERE application_id IN ${tx(apps)}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id IN ${tx(apps)}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx(applicants)}`;
  });
}

async function main(): Promise<void> {
  console.log('\n── seed');
  await cleanup().catch(() => undefined);
  await seed();

  const GENEROUS = Object.fromEntries(Object.entries(DEFAULT_PROFILES).map(([k, v]) => [k, { ...v, bucketCapacity: 10_000 }])) as typeof DEFAULT_PROFILES;
  const server = await createSandboxServer({
    world: { population: pop, overlay: null, live: null, now: () => new Date(), log: silentLog, clientTokens: new Set([DEV_G2G_CLIENT_TOKEN]) },
    environment: 'development', port: 0, host: '127.0.0.1', latencyScale: 0, profiles: GENEROUS,
  });
  const bus = new InMemoryEventBus();
  const service = new VerifyClearanceCertificateService({
    gateway: new IremboCertificateGateway({ transport: new HttpIremboCertificateTransport({ baseUrl: server.url, clientToken: DEV_G2G_CLIENT_TOKEN, timeoutMs: 3000 }), env: { NODE_ENV: 'development' } }),
    identityReader: new PgApplicantIdentityReader(PII_KEY),
    repository: new PgClearanceVerificationRepository(),
    eventBus: bus,
    policy: POLICY,
    referenceHmacKey: HMAC_KEY,
  });

  try {
    console.log('\n── 1. each persona lands in its outcome (real identity read + command function)');
    for (const key of PERSONAS) {
      const number = pop.persona(key).certificates[0]?.applicationNumber ?? '';
      const command = { applicantId: applicantOf.get(key) ?? '', applicationId: applicationOf.get(key) ?? '', agency: 'RDF' as const, category: 'GENERAL_ENLISTMENT' as const, referenceDate: TODAY, clearanceCertificateNumber: number };
      let got: string;
      try {
        const out = await service.verify(command);
        got = out.kind === 'CLEARED' ? 'CLEARED' : out.kind === 'REVIEW_REQUIRED' ? `REVIEW:${out.reasons.join(',')}` : out.kind === 'CORRECTION_NEEDED' ? `CORRECTION_NEEDED:${out.code}` : out.kind;
      } catch (e) {
        got = e instanceof ClearanceRegistryUnavailableError ? 'PENDING:REGISTRY_UNAVAILABLE' : `THREW:${(e as Error).name}:${String((e as { cause?: Error }).cause?.message ?? (e as Error).message)}`;
      }
      check(`${key} → ${EXPECT[key]}`, got === EXPECT[key], got);
    }
    const unknown = await service.verify({ applicantId: applicantOf.get('P-CLEARANCE-VALID') ?? '', applicationId: randomUUID(), agency: 'RDF', category: 'GENERAL_ENLISTMENT', referenceDate: TODAY, clearanceCertificateNumber: 'S990000000000ZZZZ' }).then(() => 'returned', (e: Error) => e.name);
    check('an unknown application is refused by the engine, not recorded', unknown === 'VerificationPersistenceError', unknown);

    const events = bus.published;
    check('exactly one vetting event for CLEARED and one per REVIEW; none for corrections or the outage', events.filter((e) => e.eventType === 'RIB_VETTING_COMPLETED').length === 3);
    check('every vetting event records its source', events.filter((e) => e.eventType === 'RIB_VETTING_COMPLETED').every((e) => e.eventType === 'RIB_VETTING_COMPLETED' && e.source === 'IREMBO_CERTIFICATE'));

    console.log('\n── 2. what is stored: no name, no date of birth, HMAC + last 4');
    const rows = await admin<{ id: string; reference_hmac: string; reference_last4: string; certificate_type: string | null; binding: Record<string, string> | null; outcome: string }[]>`
      SELECT id, reference_hmac, reference_last4, certificate_type, binding, outcome FROM rdf_ops.clearance_certificate_verifications
      WHERE application_id IN ${admin([...applicationOf.values()])}`;
    check('one row per persona', rows.length === PERSONAS.length, String(rows.length));
    const dump = JSON.stringify(rows);
    const valid = pop.persona('P-CLEARANCE-VALID');
    const number = valid.certificates[0]?.applicationNumber ?? '';
    for (const secret of [valid.surname, valid.forename, valid.dateOfBirth, valid.nid, number, pop.persona('P-CLEARANCE-NAME-MISMATCH').certificates[0]?.name ?? '']) {
      check(`the stored rows hold no ${secret.length > 6 ? 'value' : 'token'} of the compared data`, !dump.includes(secret));
    }
    check('reference is a 64-hex HMAC and the last 4 characters', rows.every((r) => /^[0-9a-f]{64}$/.test(r.reference_hmac) && /^[A-Z0-9*]{4}$/.test(r.reference_last4)));
    check('binding holds per-field results only', rows.every((r) => r.binding === null || Object.values(r.binding).every((v) => ['MATCH', 'PARTIAL', 'MISMATCH', 'NOT_COMPARED', 'UNREADABLE'].includes(v))));
    const columns = await admin<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'rdf_ops' AND table_name = 'clearance_certificate_verifications'`;
    check('no column could hold a name or a date of birth', !columns.some((c) => /name|birth|dob|nid|national/i.test(c.column_name)), columns.map((c) => c.column_name).join(','));

    console.log('\n── 3. append-only and the write boundary');
    const id = rows[0]?.id ?? '';
    await refused('admin UPDATE refused', () => admin`UPDATE rdf_ops.clearance_certificate_verifications SET outcome = 'CLEARED' WHERE id = ${id}`, /append-only/);
    await refused('admin DELETE refused', () => admin`DELETE FROM rdf_ops.clearance_certificate_verifications WHERE id = ${id}`, /append-only/);
    await refused('admin TRUNCATE refused', () => admin`TRUNCATE rdf_ops.clearance_certificate_verifications`, /append-only/);
    await refused('the table owner role cannot UPDATE either', () => admin.begin(async (tx) => { await tx`SET LOCAL ROLE usrp_clearance_owner`; await tx`UPDATE rdf_ops.clearance_certificate_verifications SET outcome = 'CLEARED' WHERE id = ${id}`; }), /append-only|permission denied/);
    for (const role of ['usrp_vetting_service', 'usrp_rdf_officer', 'usrp_system_service']) {
      await refused(`direct INSERT refused for ${role}`, () => sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(role)}`;
        await tx`INSERT INTO rdf_ops.clearance_certificate_verifications (application_id, reference_hmac, reference_last4, outcome, failure_code) VALUES (${applicationOf.get('P-CLEARANCE-VALID') ?? ''}, ${'0'.repeat(64)}, 'ABCD', 'PENDING', 'REGISTRY_UNAVAILABLE')`;
      }), /permission denied|row-level security/);
    }
    const app = applicationOf.get('P-CLEARANCE-VALID') ?? '';
    const call = (args: { hmac?: string; outcome?: string; failure?: string | null; binding?: string | null }) => `SELECT rdf_ops.record_clearance_verification('${app}'::uuid, '${args.hmac ?? '1'.repeat(64)}', 'ABCD', NULL, NULL, '${args.outcome ?? 'PENDING'}', ${args.failure === null ? 'NULL' : `'${args.failure ?? 'REGISTRY_UNAVAILABLE'}'`}, ARRAY[]::text[], ${args.binding === undefined || args.binding === null ? 'NULL' : `'${args.binding}'::jsonb`}, NULL, NULL)`;
    await refused('the command function refuses the system-service role', () => sql.begin(async (tx) => { await tx`SET LOCAL ROLE usrp_system_service`; await tx.unsafe(call({})); }), /permission denied|vetting-service/);
    await refused('the command function refuses an officer role', () => sql.begin(async (tx) => { await tx`SET LOCAL ROLE usrp_rdf_officer`; await tx.unsafe(call({})); }), /permission denied|vetting-service/);
    await refused('the command function refuses the bare login with no service role', () => sql.begin(async (tx) => { await tx.unsafe(call({})); }), /permission denied|vetting-service/);
    const viaFn = async (args: Parameters<typeof call>[0]): Promise<{ outcome?: string }> => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_vetting_service`;
      const r = await tx.unsafe(call(args));
      return (r[0] as unknown as { record_clearance_verification: { outcome?: string } }).record_clearance_verification;
    });
    const first = await viaFn({ hmac: '2'.repeat(64) });
    const second = await viaFn({ hmac: '2'.repeat(64) });
    check('a redelivery concluding the same thing is idempotent (RECORDED then ALREADY_RECORDED)', first.outcome === 'RECORDED' && second.outcome === 'ALREADY_RECORDED', `${String(first.outcome)}/${String(second.outcome)}`);
    await refused('an inconsistent row is refused by the CHECK (CLEARED with a failure code)', () => viaFn({ hmac: '3'.repeat(64), outcome: 'CLEARED', failure: 'CERTIFICATE_EXPIRED' }), /check/i);
    await refused('the binding column refuses a value (a name)', () => viaFn({ hmac: '4'.repeat(64), outcome: 'CORRECTION_NEEDED', failure: 'CERTIFICATE_NOT_BOUND', binding: '{"name":"KAMANZI Olivier"}' }), /never values|per-field/);
    await refused('the binding column refuses an unknown key', () => viaFn({ hmac: '5'.repeat(64), outcome: 'CORRECTION_NEEDED', failure: 'CERTIFICATE_NOT_BOUND', binding: '{"holderName":"MATCH"}' }), /never values|per-field/);

    console.log('\n── 4. isolation: only the owning agency\'s officer (and the system service) can read');
    const asRole = async (role: string): Promise<number> => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(role)}`;
      const r = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM rdf_ops.clearance_certificate_verifications WHERE application_id = ${app}`;
      return r[0]?.n ?? 0;
    }).catch(() => -1);
    check('the RDF officer reads the application\'s verification rows', (await asRole('usrp_rdf_officer')) > 0);
    check('the system service reads them (the citizen\'s own checklist)', (await asRole('usrp_system_service')) > 0);
    check('an RNP officer sees none (or is refused)', (await asRole('usrp_rnp_officer')) <= 0);
    check('an RCS officer sees none (or is refused)', (await asRole('usrp_rcs_officer')) <= 0);
    check('the vetting service role itself cannot read the table back', (await asRole('usrp_vetting_service')) <= 0);
  } finally {
    await server.stop();
    await cleanup().catch((e: unknown) => { console.error('cleanup failed', e); });
    await Promise.all([sql.end({ timeout: 5 }), admin.end({ timeout: 5 })]);
  }
  if (failures > 0) { console.error(`\n✗ clearance proof FAILED — ${String(failures)} check(s)`); process.exit(1); }
  console.log('\n✓ clearance proof passed');
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
