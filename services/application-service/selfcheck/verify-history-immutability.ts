// ══════════════════════════════════════════════════════════════════
// application-service — status-history immutability self-check (0007)
//
// Proves rdf_ops.application_status_history is append-only in the ENGINE, not
// by convention — the mirror of the audit-service 0002 proof, for the
// application's forensic status timeline (Law N° 058/2021):
//
//   1. APPEND works — usrp_system_service can INSERT a history row.
//   2. UPDATE / DELETE / TRUNCATE are rejected for EVERY role — attempted here
//      as the table OWNER (usrp_admin), the hardest case grants alone can't
//      stop; the 0007 trigger refuses unconditionally.
//   3. The row survives every tamper attempt, byte-for-byte.
//   4. Grant introspection — usrp_system_service keeps INSERT + SELECT but was
//      stripped of UPDATE / DELETE on the history table.
//
// Repeatable: seeds a minimal identity + application, appends one history row,
// asserts, then tears down through the documented superuser escape hatch
// (session_replication_role = replica) — the only way to delete append-only
// rows, used deliberately and locally for test maintenance.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   pnpm --filter @usrp/application-service exec tsx selfcheck/verify-history-immutability.ts
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from '@usrp/shared-database';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const APPLICANT_ID = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const NID_HASH = 'e1e2e3e4'.repeat(8);
const CAMPAIGN_ID = randomUUID(); // campaign_id has no FK — any uuid is fine
const PROCESSING_CODE = `RDF-HISTTEST-${randomUUID().slice(0, 6)}`;

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Run a mutation expected to be REFUSED by the immutability trigger. */
async function expectRejected(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    check(label, false, 'mutation was NOT rejected');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(label, /append-only/.test(msg), msg);
  }
}

async function teardown(): Promise<void> {
  // Delete append-only rows via the superuser escape hatch (disables triggers,
  // incl. the immutability + FK triggers, for this maintenance tx only).
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN (
      SELECT id FROM rdf_ops.applications WHERE applicant_id = ${APPLICANT_ID})`;
    await tx`DELETE FROM rdf_ops.applications WHERE applicant_id = ${APPLICANT_ID}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
  });
}

async function main(): Promise<void> {
  await teardown();

  // Seed a minimal VERIFIED identity (encrypted columns are opaque here — this
  // proof never decrypts) and one application, as the superuser owner.
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (${APPLICANT_ID}, ${NID_HASH}, 'x','x','x','x','MALE','WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
  const appRows = await admin<{ id: string }[]>`
    INSERT INTO rdf_ops.applications
      (processing_code, applicant_id, campaign_id, category, status, submitted_at)
    VALUES (${PROCESSING_CODE}, ${APPLICANT_ID}, ${CAMPAIGN_ID},
            'GENERAL_ENLISTMENT'::rdf_ops.application_category, 'SUBMITTED', now())
    RETURNING id`;
  const applicationId = appRows[0]?.id;
  if (!applicationId) throw new Error('failed to seed application');
  console.log(`\nSeeded application ${applicationId} (${PROCESSING_CODE})`);

  // ── 1. Append works as the legitimate writer (usrp_system_service) ──
  console.log('\n── 1. Append (INSERT) as usrp_system_service ────────────────');
  const correlationId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_system_service`;
    await tx`
      INSERT INTO rdf_ops.application_status_history
        (application_id, from_status, to_status, reason, performed_by, correlation_id)
      VALUES (${applicationId}, NULL, 'SUBMITTED', 'seed for immutability proof',
              'SYSTEM', ${correlationId})`;
  });
  const seeded = await admin<{ id: string; to_status: string }[]>`
    SELECT id, to_status FROM rdf_ops.application_status_history
    WHERE application_id = ${applicationId}`;
  check('system_service appended exactly one history row', seeded.length === 1, `${seeded.length}`);
  check('appended row is SUBMITTED', seeded[0]?.to_status === 'SUBMITTED', seeded[0]?.to_status);
  const historyId = seeded[0]?.id;
  if (historyId === undefined) throw new Error('history row seed returned no id');

  // ── 2. UPDATE / DELETE / TRUNCATE rejected — as the table OWNER ─────
  console.log('\n── 2. Mutation rejected for EVERY role (attempted as owner) ──');
  await expectRejected('UPDATE rejected (even as table owner)', () =>
    admin`UPDATE rdf_ops.application_status_history SET to_status = 'REJECTED' WHERE id = ${historyId}`,
  );
  await expectRejected('DELETE rejected (even as table owner)', () =>
    admin`DELETE FROM rdf_ops.application_status_history WHERE id = ${historyId}`,
  );
  await expectRejected('TRUNCATE rejected (even as table owner)', () =>
    admin`TRUNCATE rdf_ops.application_status_history`,
  );

  // ── 3. The row survived untampered ─────────────────────────────────
  console.log('\n── 3. The row survived every tamper attempt ─────────────────');
  const after = await admin<{ to_status: string; reason: string }[]>`
    SELECT to_status, reason FROM rdf_ops.application_status_history WHERE id = ${historyId}`;
  check('row still present', after.length === 1);
  check('to_status unchanged (SUBMITTED)', after[0]?.to_status === 'SUBMITTED', after[0]?.to_status);
  check('reason unchanged', after[0]?.reason === 'seed for immutability proof', after[0]?.reason);

  // ── 4. Grant introspection — append + read only ────────────────────
  console.log('\n── 4. usrp_system_service grants: INSERT+SELECT, NOT UPDATE/DELETE ──');
  const grants = await admin<{ privilege_type: string }[]>`
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'usrp_system_service'
      AND table_schema = 'rdf_ops' AND table_name = 'application_status_history'`;
  const g = new Set(grants.map((r) => r.privilege_type));
  check('granted INSERT', g.has('INSERT'));
  check('granted SELECT', g.has('SELECT'));
  check('NOT granted UPDATE (revoked by 0007)', !g.has('UPDATE'));
  check('NOT granted DELETE', !g.has('DELETE'));

  await teardown();

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('APPLICATION STATUS-HISTORY IMMUTABILITY PROVEN IN THE ENGINE ✓');
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
