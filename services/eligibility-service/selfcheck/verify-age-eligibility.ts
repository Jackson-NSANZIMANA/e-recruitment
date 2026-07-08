// ══════════════════════════════════════════════════════════════════
// eligibility-service — Live age-eligibility self-check (ADR-005)
//
// Seeds a VERIFIED and a PENDING applicant-identity fixture (real
// encrypted DOB, written as the system service), boots the eligibility
// service over @usrp/shared-http on an ephemeral port, and drives it
// through a real socket with fetch — asserting every branch and the
// invariant that the raw date of birth never leaks into a response or an
// event. Repeatable: cleans its fixtures before and after; exits non-zero
// on the first failed assertion.
//
//   Run (repo root), Tier-1 Postgres up:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   pnpm --filter @usrp/eligibility-service selfcheck
// ══════════════════════════════════════════════════════════════════

import { randomUUID, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { sql } from '@usrp/shared-database';
import { InMemoryEventBus } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { ageEligibilityRoute, ageInYears, createEligibilityService, loadEligibilityConfig } from '../src/index.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const FIXTURE_DOB = '2003-03-15'; // matches the seeded NIDA citizen; ~23 as of 2026
const AGE_CHECK = '/v1/eligibility/age-check';
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Insert an applicant_identities fixture as the system service; return its id. */
async function seedIdentity(
  encryptionKey: string,
  nationalIdHash: string,
  identityStatus: 'VERIFIED' | 'PENDING',
): Promise<string> {
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
        pgp_sym_encrypt('Fixture Person', current_setting('app.encryption_key')),
        pgp_sym_encrypt(${FIXTURE_DOB},   current_setting('app.encryption_key')),
        pgp_sym_encrypt('GASABO',         current_setting('app.encryption_key')),
        pgp_sym_encrypt('KIGALI_CITY',    current_setting('app.encryption_key')),
        'MALE'::public_core.gender,
        'WEB'::public_core.application_channel,
        ${identityStatus}::public_core.identity_verification_status,
        ${randomUUID()}, now(), null, null
      )
      RETURNING id
    `;
    const row = rows[0];
    if (!row) throw new Error('fixture insert returned no row');
    return row.id;
  });
}

async function cleanup(hashes: readonly string[]): Promise<void> {
  await admin`DELETE FROM public_core.applicant_identities WHERE national_id_hash IN ${admin(hashes)}`;
}

async function main(): Promise<void> {
  // The age gate never calls NESA, but the composed config now includes the
  // NESA endpoint (the education gate shares this service). Supply harmless
  // defaults so this age-only selfcheck needs no live NESA.
  const config = loadEligibilityConfig({
    NESA_BASE_URL: 'http://localhost:3101',
    NESA_HMAC_SECRET: 'dev_nesa_hmac_secret',
    ...process.env,
  });
  const bus = new InMemoryEventBus();
  const service = createEligibilityService(config, bus).age;

  const hashVerified = randomBytes(32).toString('hex');
  const hashPending = randomBytes(32).toString('hex');
  await cleanup([hashVerified, hashPending]);

  const verifiedId = await seedIdentity(config.security.encryptionKey, hashVerified, 'VERIFIED');
  const pendingId = await seedIdentity(config.security.encryptionKey, hashPending, 'PENDING');

  const expectedAge = ageInYears(FIXTURE_DOB, new Date());
  const eligibleGeneral = expectedAge >= 18 && expectedAge <= 25; // GENERAL_ENLISTMENT band
  const eligibleUR = expectedAge >= 18 && expectedAge <= 21; // OFFICER_FOUR_YEAR_UR band

  const server = await startHttpServer({
    serviceName: 'eligibility-service-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [ageEligibilityRoute(service)],
    readiness: async (): Promise<boolean> => {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    handleSignals: false,
  });
  const base = server.url;
  console.log(`\nServer listening at ${base} — fixture age ${expectedAge}`);

  const bodies: string[] = [];
  async function call(
    method: string,
    path: string,
    init?: { readonly headers?: Record<string, string>; readonly body?: string },
  ): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
    const res = await fetch(`${base}${path}`, {
      method,
      ...(init?.headers ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    const text = await res.text();
    bodies.push(text);
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, headers: res.headers };
  }
  const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

  try {
    console.log('\n── 1. Verified applicant, in-band category → EVALUATED eligible ──');
    const r1 = await call('POST', AGE_CHECK, {
      headers: { ...JSON_HEADERS, 'x-correlation-id': CORRELATION_ID },
      body: JSON.stringify({ applicantId: verifiedId, category: 'GENERAL_ENLISTMENT' }),
    });
    const b1 = asRecord(r1.json);
    check('status is 200', r1.status === 200, `got ${r1.status}`);
    check('status is EVALUATED', b1['status'] === 'EVALUATED');
    check(`ageAtEvaluation is ${expectedAge}`, b1['ageAtEvaluation'] === expectedAge, String(b1['ageAtEvaluation']));
    check(`eligible === ${eligibleGeneral} for GENERAL_ENLISTMENT`, b1['eligible'] === eligibleGeneral, String(b1['eligible']));
    check('agency resolved to RDF', b1['agency'] === 'RDF', String(b1['agency']));
    check('response body carries NO dateOfBirth', !('dateOfBirth' in b1));
    check('response echoes x-correlation-id', r1.headers.get('x-correlation-id') === CORRELATION_ID);
    check(
      'AUDIT_ENTRY published with the inbound correlationId',
      bus.published.length === 1 &&
        bus.published[0]?.eventType === 'AUDIT_ENTRY' &&
        bus.published[0]?.correlationId === CORRELATION_ID,
    );

    console.log('\n── 2. Same applicant, strict band (18–21) → over-age INELIGIBLE ──');
    const r2 = await call('POST', AGE_CHECK, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ applicantId: verifiedId, category: 'OFFICER_FOUR_YEAR_UR' }),
    });
    const b2 = asRecord(r2.json);
    check('status is 200', r2.status === 200, `got ${r2.status}`);
    check(`eligible === ${eligibleUR} for OFFICER_FOUR_YEAR_UR`, b2['eligible'] === eligibleUR, String(b2['eligible']));
    check('appliedMaxAge is 21', b2['appliedMaxAge'] === 21, String(b2['appliedMaxAge']));
    check('agency resolved to RCS', b2['agency'] === 'RCS', String(b2['agency']));

    console.log('\n── 3. Unknown applicant → 404 ───────────────────────────────');
    const r3 = await call('POST', AGE_CHECK, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ applicantId: randomUUID(), category: 'GENERAL_ENLISTMENT' }),
    });
    check('status is 404 APPLICANT_NOT_FOUND', r3.status === 404 && asRecord(r3.json)['status'] === 'APPLICANT_NOT_FOUND', `${r3.status} ${r3.text}`);

    console.log('\n── 4. Unverified identity → 409 ─────────────────────────────');
    const r4 = await call('POST', AGE_CHECK, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ applicantId: pendingId, category: 'GENERAL_ENLISTMENT' }),
    });
    check('status is 409 IDENTITY_NOT_VERIFIED', r4.status === 409 && asRecord(r4.json)['status'] === 'IDENTITY_NOT_VERIFIED', `${r4.status} ${r4.text}`);
    check('no event published for a rejected precondition', bus.published.length === 2, `got ${bus.published.length}`);

    console.log('\n── 5. Input validation → 400 ────────────────────────────────');
    const badId = await call('POST', AGE_CHECK, { headers: JSON_HEADERS, body: JSON.stringify({ applicantId: 'not-a-uuid', category: 'GENERAL_ENLISTMENT' }) });
    check('bad applicantId → 400 INVALID_APPLICANT_ID', badId.status === 400 && asRecord(badId.json)['error'] === 'INVALID_APPLICANT_ID', `${badId.status} ${badId.text}`);
    const badCat = await call('POST', AGE_CHECK, { headers: JSON_HEADERS, body: JSON.stringify({ applicantId: verifiedId, category: 'NOT_A_CATEGORY' }) });
    check('bad category → 400 INVALID_CATEGORY', badCat.status === 400 && asRecord(badCat.json)['error'] === 'INVALID_CATEGORY', `${badCat.status} ${badCat.text}`);

    console.log('\n── 6. Health & readiness ────────────────────────────────────');
    const health = await call('GET', '/health');
    check('GET /health → 200 ok', health.status === 200 && asRecord(health.json)['status'] === 'ok');
    const ready = await call('GET', '/ready');
    check('GET /ready → 200 ready', ready.status === 200 && asRecord(ready.json)['status'] === 'ready', `${ready.status} ${ready.text}`);

    console.log('\n── 7. The raw date of birth never leaks ─────────────────────');
    const allBodies = bodies.join('\n');
    check('DOB absent from every HTTP response body', !allBodies.includes(FIXTURE_DOB));
    const publishedJson = JSON.stringify(bus.published);
    check('DOB absent from every published event', !publishedJson.includes(FIXTURE_DOB));
  } finally {
    await cleanup([hashVerified, hashPending]);
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('ALL ELIGIBILITY AGE-SLICE ASSERTIONS PASSED ✓');
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
