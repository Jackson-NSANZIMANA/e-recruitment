// ══════════════════════════════════════════════════════════════════
// application-service — Live officer-auth + RLS self-check
//
// Proves the authentication slice end-to-end against live infrastructure:
// boots the real service (both routes) over @usrp/shared-http on an ephemeral
// port, mints Ed25519 bearer tokens with an in-test issuer key, and drives it
// through a real TCP socket. The load-bearing claim: GET /v1/applications runs
// under the OFFICER's OWN agency DB role (usrp_<agency>_officer), so the
// dormant per-agency isolation from rls/0001 finally enforces on a live
// request — an RDF officer sees only RDF applications, and the officer DB role
// is denied even the ability to read a sibling agency's ops schema.
//
//   Run (repo root), with the live Tier-1 stack up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/application-service/selfcheck/verify-auth-slice.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import {
  createApplicationService,
  loadApplicationConfig,
  submitApplicationRoute,
  listApplicationsRoute,
  LIST_APPLICATIONS_PATH,
  SUBMIT_APPLICATION_PATH,
} from '../src/index.js';

// ── In-test issuer key: set the verify public key BEFORE loading config ──
const AUTH_KEYS = generateDeviceKeyPair();
const OTHER_KEYS = generateDeviceKeyPair(); // a DIFFERENT issuer — must be rejected
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(AUTH_KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// Deterministic fixtures — one applicant with an application in EACH agency.
const APPLICANT_ID = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const NID_HASH = 'a7a7a7a7'.repeat(8); // 64 hex
const RDF_CAMPAIGN = '7c111111-1111-4111-8111-111111111111';
const RNP_CAMPAIGN = '7c222222-2222-4222-8222-222222222222';
const RDF_APP = '7a111111-1111-4111-8111-111111111111';
const RNP_APP = '7a222222-2222-4222-8222-222222222222';
const RDF_CODE = 'RDF-97001';
const RNP_CODE = 'RNP-97001';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

type Kind = 'officer' | 'system';
function mint(
  kind: Kind,
  opts: { agency?: 'RDF' | 'RNP' | 'RCS'; expiresAt?: string; key?: string } = {},
): string {
  const base = {
    v: 1 as const,
    iss: 'usrp',
    aud: 'usrp-services',
    sub: `selfcheck-${kind}`,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: opts.expiresAt ?? '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer'
      ? { ...base, kind, agency: opts.agency ?? 'RDF', roles: [] }
      : { ...base, kind };
  return signAuthToken(opts.key ?? AUTH_KEYS.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const schema of ['rdf_ops', 'rnp_ops'] as const) {
      await tx`
        DELETE FROM ${tx(schema)}.application_status_history
        WHERE application_id IN (SELECT id FROM ${tx(schema)}.applications WHERE applicant_id = ${APPLICANT_ID})`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE applicant_id = ${APPLICANT_ID}`;
    }
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([RDF_CAMPAIGN, RNP_CAMPAIGN])}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
  });
}

async function seed(): Promise<void> {
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (${APPLICANT_ID}, ${NID_HASH}, 'x', 'x', 'x', 'x', 'MALE', 'WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${RDF_CAMPAIGN}, 'Auth-check RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
      (${RNP_CAMPAIGN}, 'Auth-check RNP', 'RNP', 'REGISTRATION_OPEN', '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;
  // One application in EACH agency for the SAME applicant.
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RDF_APP}, ${RDF_CODE}, ${APPLICANT_ID}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT', 'SUBMITTED')`;
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RNP_APP}, ${RNP_CODE}, ${APPLICANT_ID}, ${RNP_CAMPAIGN}, 'CADET_OFFICER', 'SUBMITTED')`;
}

async function main(): Promise<void> {
  const config = loadApplicationConfig();
  const bus = new InMemoryEventBus();
  const service = createApplicationService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  await cleanup();
  await seed();

  const server = await startHttpServer({
    serviceName: 'application-service-auth-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [submitApplicationRoute(service.submit, verify), listApplicationsRoute(service.list, verify)],
    handleSignals: false,
  });
  const base = server.url;
  console.log(`\nServer listening at ${base}`);

  async function get(
    path: string,
    token?: string,
  ): Promise<{ status: number; text: string; json: unknown }> {
    const res = await fetch(`${base}${path}`, {
      method: 'GET',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  }
  const asRecord = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

  try {
    console.log('\n── 1. Officer read scoped to own agency (RLS via officer DB role) ──');
    const rdf = await get(LIST_APPLICATIONS_PATH, mint('officer', { agency: 'RDF' }));
    const rdfBody = asRecord(rdf.json);
    check('RDF officer GET → 200', rdf.status === 200, `got ${rdf.status} ${rdf.text}`);
    check('body.agency == RDF', rdfBody['agency'] === 'RDF', String(rdfBody['agency']));
    check('response contains the RDF application', rdf.text.includes(RDF_CODE));
    check('response does NOT contain the RNP application (agency bound to token)', !rdf.text.includes(RNP_CODE));
    const apps = Array.isArray(rdfBody['applications']) ? (rdfBody['applications'] as unknown[]) : [];
    check('exactly the RDF app is listed', apps.length >= 1 && apps.every((a) => String(asRecord(a)['processingCode']).startsWith('RDF-')));

    console.log('\n── 2. Cross-agency isolation at the DB role level (direct) ──');
    // As usrp_rdf_officer, reading rnp_ops.applications must be permission-denied.
    let threw = false;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql('usrp_rdf_officer')}`;
        await tx`SELECT count(*) FROM rnp_ops.applications`;
      });
    } catch {
      threw = true;
    }
    check('usrp_rdf_officer denied reading rnp_ops.applications', threw);

    console.log('\n── 3. Officer-RLS on the shared identity table ──');
    // As usrp_rnp_officer the seeded applicant IS visible (an RNP app exists →
    // policy pc_ai_rnp); the identity leak surface is governed by RLS.
    const visible = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql('usrp_rnp_officer')}`;
      const rows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
      return rows[0]?.n ?? -1;
    });
    check('usrp_rnp_officer sees the applicant (has an RNP application)', visible === 1, String(visible));

    console.log('\n── 4. Token rejection: 401 on missing/garbage/expired/wrong-key ──');
    check('no token → 401', (await get(LIST_APPLICATIONS_PATH)).status === 401);
    check('garbage token → 401', (await get(LIST_APPLICATIONS_PATH, 'not.a.valid.token')).status === 401);
    check(
      'expired token → 401',
      (await get(LIST_APPLICATIONS_PATH, mint('officer', { agency: 'RDF', expiresAt: '2020-01-01T00:00:00.000Z' }))).status === 401,
    );
    check(
      'wrong-issuer-key token → 401',
      (await get(LIST_APPLICATIONS_PATH, mint('officer', { agency: 'RDF', key: OTHER_KEYS.privateKeyPem }))).status === 401,
    );

    console.log('\n── 5. Wrong principal kind → 403 ──');
    check('system token on officer route → 403', (await get(LIST_APPLICATIONS_PATH, mint('system'))).status === 403);

    console.log('\n── 6. Front door rejects unauthenticated + reserved paths public ──');
    const noAuthPost = await fetch(`${base}${SUBMIT_APPLICATION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ applicantId: APPLICANT_ID, category: 'GENERAL_ENLISTMENT', channel: 'WEB', nesaIndexNumber: 'x' }),
    });
    check('unauthenticated POST /v1/applications → 401', noAuthPost.status === 401, `got ${noAuthPost.status}`);
    check('GET /health (no token) → 200', (await get('/health')).status === 200);

    console.log('\n── 7. No PII leak in the officer listing ──');
    const leak = await get(LIST_APPLICATIONS_PATH, mint('officer', { agency: 'RDF' }));
    check('listing contains no national_id_hash', !leak.text.includes(NID_HASH));
  } finally {
    await cleanup();
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('OFFICER AUTH + RLS PROVEN (live) ✓');
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
