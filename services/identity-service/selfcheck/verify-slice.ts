// ══════════════════════════════════════════════════════════════════
// identity-service — Live vertical-slice self-check
//
// Exercises the WHOLE slice against real infrastructure (live PostgreSQL
// as usrp_app + live usrp-nida-mock + InMemoryEventBus) and asserts every
// correctness claim end-to-end. Repeatable: cleans its test rows before
// and after. Exits non-zero on the first failed assertion.
//
//   Run (from repo root), with the live Tier-1 stack up:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   NIDA_BASE_URL='http://localhost:3100' \
//   NIDA_HMAC_SECRET='dev_nida_hmac_secret' \
//   NATIONAL_ID_HMAC_KEY='dev_national_id_hmac_key_min_32_chars!!' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   pnpm --filter @usrp/identity-service selfcheck
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { hashNationalId } from '@usrp/shared-security';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { createIdentityService, loadIdentityConfig } from '../src/index.js';

// Test teardown hard-deletes rows for repeatability. The application role
// (usrp_app/system_service) intentionally has no DELETE — erasure is the
// soft-delete path — so teardown uses a superuser admin connection.
const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Known seeded test citizen (see infrastructure/docker/mocks/nida) ──
const CITIZEN_NID = '1200380123456789'; // UWIMANA Jean Pierre — RWANDAN_CITIZEN, GASABO
const CITIZEN_NAME = 'UWIMANA Jean Pierre';
const CITIZEN_DISTRICT = 'GASABO';
// A syntactically-valid NID that is NOT in the NIDA seed → NOT_FOUND path.
const UNKNOWN_NID = '1200380123400000';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup(hashes: readonly string[]): Promise<void> {
  // admin is superuser (bypasses RLS) and owns the table — hard delete.
  await admin`DELETE FROM public_core.applicant_identities WHERE national_id_hash IN ${admin(hashes)}`;
}

async function main(): Promise<void> {
  const config = loadIdentityConfig();
  const bus = new InMemoryEventBus();
  const service = createIdentityService(config, bus);

  const citizenHash = hashNationalId(CITIZEN_NID, config.security.nationalIdHmacKey);
  const unknownHash = hashNationalId(UNKNOWN_NID, config.security.nationalIdHmacKey);

  // Clean slate so CREATED is not masked by a prior run's row.
  await cleanup([citizenHash, unknownHash]);

  console.log('\n── 1. Happy path: NIDA FOUND → identity CREATED ──────────────');
  const created = await service.verify({ rawNationalId: CITIZEN_NID, registrationChannel: 'WEB' });
  check('outcome is CREATED', created.kind === 'CREATED', `got ${created.kind}`);
  const applicantId = 'applicantId' in created ? created.applicantId : '';
  check('applicantId is a UUID', /^[0-9a-f-]{36}$/.test(applicantId), applicantId);
  check(
    'NIDA_VERIFICATION_COMPLETED published',
    bus.published.length === 1 && bus.published[0]?.eventType === 'NIDA_VERIFICATION_COMPLETED',
  );
  const evt = bus.published[0];
  if (evt && evt.eventType === 'NIDA_VERIFICATION_COMPLETED') {
    check('event.verified === true', evt.verified === true);
    check('event carries homeDistrict from NIDA', evt.homeDistrict === CITIZEN_DISTRICT, String(evt.homeDistrict));
    check('event.applicantId matches created row', evt.applicantId === applicantId);
    check('event has a correlationId', typeof evt.correlationId === 'string' && evt.correlationId.length === 36);
  }

  console.log('\n── 2. PII is encrypted at rest AND decryptable ───────────────');
  const [rest] = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_system_service`;
    await tx`SELECT set_config('app.encryption_key', ${config.security.encryptionKey}, true)`;
    return tx<{ ciphertext: string; plaintext: string; status: string }[]>`
      SELECT
        encrypted_full_name AS ciphertext,
        pgp_sym_decrypt(encrypted_full_name::bytea, current_setting('app.encryption_key')) AS plaintext,
        identity_status AS status
      FROM public_core.applicant_identities
      WHERE national_id_hash = ${citizenHash}
    `;
  });
  check('row persisted with status VERIFIED', rest?.status === 'VERIFIED', String(rest?.status));
  check('stored column is ciphertext, not plaintext', !!rest && !rest.ciphertext.includes('UWIMANA'));
  check('decrypts to the correct name with the key', rest?.plaintext === CITIZEN_NAME, String(rest?.plaintext));

  console.log('\n── 3. Wrong key cannot decrypt (pgcrypto integrity) ──────────');
  let wrongKeyRejected = false;
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_system_service`;
      await tx`SELECT pgp_sym_decrypt(encrypted_full_name::bytea, 'a_totally_wrong_key')
               FROM public_core.applicant_identities WHERE national_id_hash = ${citizenHash}`;
    });
  } catch {
    wrongKeyRejected = true;
  }
  check('decryption with wrong key is rejected', wrongKeyRejected);

  console.log('\n── 4. Cross-agency RLS: new identity invisible to RDF officer ─');
  const visibility = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_rdf_officer`;
    const rdf = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public_core.applicant_identities WHERE id = ${applicantId}`;
    await tx`RESET ROLE`;
    await tx`SET LOCAL ROLE usrp_system_service`;
    const sys = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public_core.applicant_identities WHERE id = ${applicantId}`;
    return { rdf: rdf[0]?.n ?? -1, sys: sys[0]?.n ?? -1 };
  });
  check('RDF officer cannot see the identity (no RDF application)', visibility.rdf === 0, `got ${visibility.rdf}`);
  check('system service CAN see the identity', visibility.sys === 1, `got ${visibility.sys}`);

  console.log('\n── 5. Idempotency: re-verifying the same NID ─────────────────');
  const again = await service.verify({ rawNationalId: CITIZEN_NID, registrationChannel: 'WEB' });
  check('outcome is ALREADY_EXISTS', again.kind === 'ALREADY_EXISTS', `got ${again.kind}`);
  check('same applicantId returned', 'applicantId' in again && again.applicantId === applicantId);
  check('no duplicate event published', bus.published.length === 1);

  console.log('\n── 6. NOT_FOUND path emits an audit event, creates no row ────');
  const notFound = await service.verify({ rawNationalId: UNKNOWN_NID, registrationChannel: 'USSD' });
  check('outcome is NOT_FOUND_IN_NIDA', notFound.kind === 'NOT_FOUND_IN_NIDA', `got ${notFound.kind}`);
  check(
    'AUDIT_ENTRY published for the failed verification',
    bus.published.length === 2 && bus.published[1]?.eventType === 'AUDIT_ENTRY',
  );
  const unknownRow = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_system_service`;
    const r = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public_core.applicant_identities WHERE national_id_hash = ${unknownHash}`;
    return r[0]?.n ?? -1;
  });
  check('no identity row created for unknown NID', unknownRow === 0, `got ${unknownRow}`);

  console.log('\n── 7. Raw National ID never leaks into events ────────────────');
  const publishedJson = JSON.stringify(bus.published);
  check('raw NID absent from all published events', !publishedJson.includes(CITIZEN_NID) && !publishedJson.includes(UNKNOWN_NID));

  // ── Teardown ────────────────────────────────────────────────────
  await cleanup([citizenHash, unknownHash]);

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) {
    console.log('ALL IDENTITY-SLICE ASSERTIONS PASSED ✓');
  } else {
    console.error(`${failures} ASSERTION(S) FAILED ✗`);
  }
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
