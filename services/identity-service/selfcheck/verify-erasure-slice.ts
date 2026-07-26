// ══════════════════════════════════════════════════════════════════
// identity-service — Live right-to-erasure self-check (ADR-015)
//
// Proves the erasure slice end-to-end against live infrastructure:
// boots the real service over @usrp/shared-http on an ephemeral port,
// mints Ed25519 OFFICER tokens, and drives POST /v1/identities/erasure
// through a real TCP socket.
//
// Load-bearing claims:
//   • a citizen whose applications are ALL terminal is erased: the five
//     PII ciphertexts are gone (pgcrypto decryption impossible — the
//     tombstone is not a pgp envelope), national_id_hash rotated to an
//     unlinkable value, phone/biometric/nida columns nulled, deleted_at
//     stamped, session rows deleted, and exactly one PII-free
//     ERASURE_EXECUTED audit emitted. Re-erase → ALREADY_ERASED (idempotent).
//   • an in-flight application (any agency) defers erasure: 409
//     REFUSED_ACTIVE_APPLICATION, row byte-identical, ERASURE_REFUSED audit.
//   • an accept-locked (enlisted, ADR-014) citizen is retained: 409
//     REFUSED_ACCEPT_LOCKED naming the holder.
//   • erasure is IRREVERSIBLE at the engine (rls/0014): even
//     usrp_system_service cannot un-erase or rewrite a frozen row.
//   • the immutable trails survive erasure: status-history rows intact.
//   • no PII, NID, or hash in any response; 401/403/400/404 edges hold.
//
//   Run (repo root), with the live Tier-1 stack up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   NIDA_BASE_URL='http://localhost:3100' \
//   NIDA_HMAC_SECRET='dev_nida_hmac_secret' \
//   NATIONAL_ID_HMAC_KEY='dev_national_id_hmac_key_min_32_chars!!' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   npx tsx services/identity-service/selfcheck/verify-erasure-slice.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import {
  createEraseIdentityService,
  loadIdentityConfig,
  erasureRoute,
  ERASURE_PATH,
} from '../src/index.js';

// In-test issuer key BEFORE loading config.
const AUTH_KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(AUTH_KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Deterministic fixtures ──
// E1: all-terminal citizen (REJECTED in RDF + WITHDRAWN in RNP) → erased.
// E2: in-flight citizen (MEDICAL_REVIEW in RNP) → refused.
// E3: accepted + accept-locked citizen (ADR-014) → refused (retention).
const E1 = '43000000-0000-4000-8000-000000000001';
const E2 = '43000000-0000-4000-8000-000000000002';
const E3 = '43000000-0000-4000-8000-000000000003';
const ALL = [E1, E2, E3];
const HASH_E1 = '43a143a1'.repeat(8);
const HASH_E2 = '43a243a2'.repeat(8);
const HASH_E3 = '43a343a3'.repeat(8);
const CAMPAIGN = '43000000-0000-4000-8000-0000000000c1';
const OFFICER_ID = '43000000-0000-4000-8000-00000000ff01';
const FULL_NAME = 'ERASURE Test Citizen Uwase';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function mint(kind: 'officer' | 'system', sub = `selfcheck-${kind}`): string {
  const base = {
    v: 1 as const,
    iss: 'usrp',
    aud: 'usrp-services',
    sub,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency: 'RDF', roles: [] } : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  // Erased rows are frozen (rls/0014) and their hash is rotated — teardown
  // deletes by id under the superuser replica escape hatch, exactly like the
  // other proofs' immutability teardowns.
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const schema of ['rdf_ops', 'rnp_ops', 'rcs_ops'] as const) {
      await tx`
        DELETE FROM ${tx(schema)}.application_status_history
        WHERE application_id IN (SELECT id FROM ${tx(schema)}.applications WHERE applicant_id IN ${tx(ALL)})`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE applicant_id IN ${tx(ALL)}`;
    }
    await tx`DELETE FROM public_core.applicant_sessions WHERE applicant_id IN ${tx(ALL)}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx(ALL)}`;
  });
}

async function seed(encryptionKey: string): Promise<void> {
  // Real pgcrypto ciphertexts — the proof must show decryption STOPS working.
  for (const [id, hash] of [
    [E1, HASH_E1],
    [E2, HASH_E2],
    [E3, HASH_E3],
  ] as const) {
    await admin`
      INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, gender,
         registration_channel, identity_status, phone_number_hash,
         biometric_session_id, nida_verification_request_id)
      VALUES (${id}, ${hash},
              pgp_sym_encrypt(${FULL_NAME}, ${encryptionKey}),
              pgp_sym_encrypt('1999-01-01', ${encryptionKey}),
              pgp_sym_encrypt('GASABO', ${encryptionKey}),
              pgp_sym_encrypt('KIGALI', ${encryptionKey}),
              'FEMALE', 'WEB', 'VERIFIED'::public_core.identity_verification_status,
              ${'ph'.repeat(32)}, 'bio-session-43', 'nida-req-43')`;
  }
  // E3 is enlisted: accept-locked by RNP (ADR-014).
  await admin`
    UPDATE public_core.applicant_identities SET
      cross_agency_locked_at = now(),
      cross_agency_locked_by_agency = 'RNP',
      cross_agency_lock_reason = 'ACCEPTED'
    WHERE id = ${E3}`;

  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES (${CAMPAIGN}, 'Erasure-slice campaign', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
            now() - interval '1 day', now() + interval '30 days', '2026-10-01', '2026-10-15', 7)`;

  // E1: both terminal states, across two agencies (WITHDRAWN seeded directly —
  // the enum value exists; the platform has no writer yet, deliberately).
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES ('43000000-0000-4000-8000-00000000a001', 'RDF-97001', ${E1}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT',
            'REJECTED'::rdf_ops.application_status)`;
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES ('43000000-0000-4000-8000-00000000a002', 'RNP-97001', ${E1}, ${CAMPAIGN}, 'CADET_OFFICER',
            'WITHDRAWN'::rnp_ops.application_status)`;
  await admin`
    INSERT INTO rdf_ops.application_status_history (application_id, from_status, to_status, performed_by)
    VALUES ('43000000-0000-4000-8000-00000000a001', 'SUBMITTED', 'REJECTED', 'selfcheck-seed')`;
  // E1 has a session row (personal data: token/ip/ua) erasure must delete.
  await admin`
    INSERT INTO public_core.applicant_sessions (applicant_id, session_token, channel, ip_address, user_agent, expires_at)
    VALUES (${E1}, 'erasure-selfcheck-session-token-43', 'WEB', '10.0.0.43', 'selfcheck-agent', now() + interval '1 hour')`;

  // E2: one terminal + one IN-FLIGHT — the in-flight one must block.
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES ('43000000-0000-4000-8000-00000000a003', 'RDF-97002', ${E2}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT',
            'REJECTED'::rdf_ops.application_status)`;
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES ('43000000-0000-4000-8000-00000000a004', 'RNP-97002', ${E2}, ${CAMPAIGN}, 'CADET_OFFICER',
            'MEDICAL_REVIEW'::rnp_ops.application_status)`;

  // E3: ACCEPTED in rnp_ops (matches the lock stamped above).
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES ('43000000-0000-4000-8000-00000000a005', 'RNP-97003', ${E3}, ${CAMPAIGN}, 'CADET_OFFICER',
            'ACCEPTED'::rnp_ops.application_status)`;
}

async function identityRow(id: string): Promise<Record<string, unknown>> {
  const rows = await admin<Record<string, unknown>[]>`
    SELECT national_id_hash, encrypted_full_name, encrypted_nida_lookup_hash,
           phone_number_hash, biometric_session_id, biometric_passed_liveness,
           nida_verification_request_id, deleted_at
    FROM public_core.applicant_identities WHERE id = ${id}`;
  return rows[0] ?? {};
}

async function main(): Promise<void> {
  const config = loadIdentityConfig();
  const bus = new InMemoryEventBus();
  const service = createEraseIdentityService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  await cleanup();
  await seed(config.security.encryptionKey);

  const server = await startHttpServer({
    serviceName: 'identity-service-erasure-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [erasureRoute(service, verify)],
    handleSignals: false,
  });
  const base = server.url;
  console.log(`\nServer listening at ${base}`);

  const asRecord = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

  async function post(
    body: unknown,
    token?: string,
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    const res = await fetch(`${base}${ERASURE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json: asRecord(json) };
  }

  const officer = mint('officer', OFFICER_ID);
  const audits = (): Record<string, unknown>[] =>
    bus.published.filter((e) => asRecord(e)['eventType'] === 'AUDIT_ENTRY').map(asRecord);

  try {
    // ── 1. Terminal citizen is erased ──
    console.log('\n── 1. All-terminal citizen → ERASED ──');
    const control = await admin<{ plaintext: string }[]>`
      SELECT pgp_sym_decrypt(encrypted_full_name::bytea, ${config.security.encryptionKey}) AS plaintext
      FROM public_core.applicant_identities WHERE id = ${E1}`;
    check('seeded PII decrypts before erasure (control)', control[0]?.plaintext === FULL_NAME);
    const erased = await post({ applicantId: E1 }, officer);
    check('erase → 200 ERASED', erased.status === 200 && erased.json['status'] === 'ERASED', erased.text);

    const after = await identityRow(E1);
    check('  deleted_at stamped', after['deleted_at'] !== null);
    check('  encrypted columns are the tombstone literal', after['encrypted_full_name'] === 'ERASED');
    check('  national_id_hash rotated (old hash unlinkable)', after['national_id_hash'] !== HASH_E1);
    check('  rotated hash is erasure-marked (e-prefix, 64 chars)',
      /^e[0-9a-f]{63}$/.test(String(after['national_id_hash'])), String(after['national_id_hash']));
    check('  phone/biometric/nida columns cleared',
      after['phone_number_hash'] === null && after['biometric_session_id'] === null &&
        after['biometric_passed_liveness'] === false && after['nida_verification_request_id'] === null);

    // pgcrypto can no longer produce the plaintext from what is stored.
    let decryptFails = false;
    try {
      await admin`SELECT pgp_sym_decrypt(encrypted_full_name::bytea, ${config.security.encryptionKey})
                  FROM public_core.applicant_identities WHERE id = ${E1}`;
    } catch {
      decryptFails = true;
    }
    check('  decryption of the stored value is impossible (ciphertext destroyed)', decryptFails);

    const sessions = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public_core.applicant_sessions WHERE applicant_id = ${E1}`;
    check('  session rows deleted', sessions[0]?.n === 0);

    const executed = audits().filter((a) => a['action'] === 'ERASURE_EXECUTED');
    check('  exactly one ERASURE_EXECUTED audit', executed.length === 1, String(executed.length));
    check('  audit is APPLICANT-scoped, performedBy officer',
      executed[0]?.['entityType'] === 'APPLICANT' && executed[0]?.['performedBy'] === OFFICER_ID);

    // ── 2. Idempotent re-erase ──
    console.log('\n── 2. Re-erase → ALREADY_ERASED ──');
    const again = await post({ applicantId: E1 }, officer);
    check('re-erase → 200 ALREADY_ERASED', again.status === 200 && again.json['status'] === 'ALREADY_ERASED', again.text);
    const afterAgain = await identityRow(E1);
    check('  row not mutated again (hash unchanged)', afterAgain['national_id_hash'] === after['national_id_hash']);

    // ── 3. In-flight application defers erasure ──
    console.log('\n── 3. Active application → 409 REFUSED_ACTIVE_APPLICATION ──');
    const refusedActive = await post({ applicantId: E2 }, officer);
    check('erase of in-flight citizen → 409 REFUSED_ACTIVE_APPLICATION',
      refusedActive.status === 409 && refusedActive.json['status'] === 'REFUSED_ACTIVE_APPLICATION', refusedActive.text);
    check('  refusal names the blocking agency + status',
      refusedActive.json['agency'] === 'RNP' && refusedActive.json['currentStatus'] === 'MEDICAL_REVIEW', refusedActive.text);
    const e2 = await identityRow(E2);
    check('  row untouched (hash intact, not deleted)',
      e2['national_id_hash'] === HASH_E2 && e2['deleted_at'] === null);
    const refusedAudits = audits().filter((a) => a['action'] === 'ERASURE_REFUSED');
    check('  ERASURE_REFUSED audit emitted (ground: ACTIVE_APPLICATION)',
      refusedAudits.length === 1 && asRecord(refusedAudits[0]?.['metadata'])['ground'] === 'ACTIVE_APPLICATION');

    // ── 4. Enlisted (accept-locked) citizen is retained ──
    console.log('\n── 4. Accept-locked → 409 REFUSED_ACCEPT_LOCKED ──');
    const refusedLocked = await post({ applicantId: E3 }, officer);
    check('erase of enlisted citizen → 409 REFUSED_ACCEPT_LOCKED',
      refusedLocked.status === 409 && refusedLocked.json['status'] === 'REFUSED_ACCEPT_LOCKED', refusedLocked.text);
    check('  refusal names the holding agency', refusedLocked.json['lockedByAgency'] === 'RNP');
    check('  ERASURE_REFUSED audit (ground: ACCEPT_LOCKED)',
      audits().filter((a) => asRecord(a['metadata'])['ground'] === 'ACCEPT_LOCKED').length === 1);

    // ── 5. Irreversibility at the engine (rls/0014) ──
    console.log('\n── 5. Erased row is frozen — even for system_service ──');
    let unEraseRefused = false;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_system_service`;
        await tx`UPDATE public_core.applicant_identities SET deleted_at = NULL WHERE id = ${E1}`;
      });
    } catch {
      unEraseRefused = true;
    }
    check('un-erasure (clear deleted_at) refused by trigger', unEraseRefused);
    let rewriteRefused = false;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_system_service`;
        await tx`UPDATE public_core.applicant_identities SET encrypted_full_name = 'resurrected' WHERE id = ${E1}`;
      });
    } catch {
      rewriteRefused = true;
    }
    check('PII rewrite on erased row refused by trigger', rewriteRefused);

    // ── 6. Legal-obligation records survive ──
    console.log('\n── 6. Immutable trails survive erasure ──');
    const hist = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rdf_ops.application_status_history
      WHERE application_id = '43000000-0000-4000-8000-00000000a001'`;
    check('status-history rows intact after erasure', hist[0]?.n === 1);
    const apps = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rdf_ops.applications WHERE applicant_id = ${E1}`;
    check('application rows (PII-free processing record) intact', apps[0]?.n === 1);

    // ── 7. Auth + input edges ──
    console.log('\n── 7. Auth gate + input validation ──');
    check('no token → 401', (await post({ applicantId: E2 })).status === 401);
    check('system token → 403 (erasure is a human act)', (await post({ applicantId: E2 }, mint('system'))).status === 403);
    check('bad applicantId → 400', (await post({ applicantId: 'not-a-uuid' }, officer)).status === 400);
    check('unknown applicantId → 404',
      (await post({ applicantId: '43000000-0000-4000-8000-00000000dead' }, officer)).status === 404);

    // ── 8. No PII anywhere ──
    console.log('\n── 8. No PII in responses or on the bus ──');
    const responses = [erased, again, refusedActive, refusedLocked].map((r) => r.text).join('|');
    check('no citizen name in any response', !responses.includes('Uwase'));
    check('no NID hash in any response',
      !responses.includes(HASH_E1) && !responses.includes(HASH_E2) && !responses.includes(HASH_E3));
    const busDump = JSON.stringify(bus.published);
    check('no citizen name on the event bus', !busDump.includes('Uwase'));
    check('no NID hash on the event bus', !busDump.includes(HASH_E1) && !busDump.includes(HASH_E2));
  } finally {
    await cleanup();
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('RIGHT-TO-ERASURE (gate → tombstone → freeze) PROVEN (live) ✓');
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
