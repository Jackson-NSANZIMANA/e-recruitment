// ══════════════════════════════════════════════════════════════════
// iam-service — Live token-issuer self-check (THE LOOP-CLOSER)
//
// Proves the keystone of the go-live vertical end-to-end against live infra:
// a token MINTED by iam-service is ACCEPTED by the REAL application-service
// officer endpoint. Two genuinely separate services, one keypair — iam holds
// the PRIVATE key and signs; application-service holds only the PUBLIC key and
// verifies. If this passes, an officer can log in and drive the pipeline we
// already built.
//
// What it asserts:
//   • seed an officer AS usrp_iam_service (proves the grant + FORCE'd RLS policy);
//   • POST /v1/auth/officer/login (good creds) → 200 + a token;
//   • LOOP-CLOSER: that token on GET /v1/applications (real app-service route,
//     booted in-proc) → 200, scoped to the token's agency;
//   • wrong password → 401; unknown handle → 401 (identical shape, no enumeration);
//   • disabled account → 401;
//   • minted claims correct (sub = UUID, kind = officer, agency, ~1h expiry);
//   • an EXPIRED minted token is rejected by the app endpoint (→ 401);
//   • a TAMPERED token is rejected (→ 401);
//   • NO password/hash appears in any response body OR the emitted AUDIT_ENTRY.
//
//   Run (repo root), Tier-1 up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/iam-service/selfcheck/verify-iam-issuer-slice.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair, hashPassword } from '@usrp/shared-security';
import { makeAuthVerifier, verifyAuthToken } from '@usrp/shared-auth';
import {
  createApplicationService,
  loadApplicationConfig,
  listApplicationsRoute,
  LIST_APPLICATIONS_PATH,
} from '@usrp/application-service';

// ── One in-test issuer keypair, shared by both sides ──────────────
// iam-service MINTS with the private key; application-service VERIFIES with the
// public key. Set BOTH env vars BEFORE either config loads. This is exactly the
// production trust split — the proof just holds both halves of the pair.
const KEYS = generateDeviceKeyPair();
const PRIVATE_B64 = Buffer.from(KEYS.privateKeyPem, 'utf8').toString('base64');
const PUBLIC_B64 = Buffer.from(
  createPublicKey(KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');
process.env['AUTH_JWT_PRIVATE_KEY_B64'] = PRIVATE_B64; // iam-service signs
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = PUBLIC_B64; // application-service verifies

// Import iam-service AFTER the env is set (config validates the key at load).
const {
  createIamService,
  loadIamConfig,
  officerLoginRoutes,
  OfficerLoginService,
  OFFICER_TOKEN_TTL_SECONDS,
} = await import('../src/index.js');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Deterministic fixtures ────────────────────────────────────────
const OFFICER_ID = '5e1fc4ec-0000-4000-8000-00000000a001'; // UUID → token sub + stamp cols
const DISABLED_ID = '5e1fc4ec-0000-4000-8000-00000000a002';
const HANDLE = 'selfcheck.rdf.officer';
const DISABLED_HANDLE = 'selfcheck.disabled.officer';
const PASSWORD = 'S3lfcheck#Officer!';
const WRONG_PASSWORD = 'not-the-password';

// One RDF application so the officer read returns a real row (loop-closer).
const APPLICANT_ID = '5e1fc4ec-1111-4111-8111-111111111111';
const NID_HASH = '5e1fc4ec'.repeat(8); // 64 hex
const RDF_CAMPAIGN = '5e1fc4ec-2222-4222-8222-222222222222';
const RDF_APP = '5e1fc4ec-3333-4333-8333-333333333333';
const RDF_CODE = 'RDF-95001';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      DELETE FROM rdf_ops.application_status_history
      WHERE application_id IN (SELECT id FROM rdf_ops.applications WHERE applicant_id = ${APPLICANT_ID})`;
    await tx`DELETE FROM rdf_ops.applications WHERE applicant_id = ${APPLICANT_ID}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${RDF_CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
    await tx`DELETE FROM public_core.officer_accounts WHERE login_handle IN ${tx([HANDLE, DISABLED_HANDLE])}`;
  });
}

async function seedOfficers(): Promise<void> {
  // Seed AS usrp_iam_service — proves the grant + WITH CHECK policy on the
  // credential store (not via the admin superuser escape hatch).
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${sql('usrp_iam_service')}`;
    await tx`
      INSERT INTO public_core.officer_accounts (officer_id, login_handle, credential, agency, roles, status)
      VALUES
        (${OFFICER_ID}, ${HANDLE}, ${hashPassword(PASSWORD)}, 'RDF', ${sql.array(['reviewer'])}, 'active'),
        (${DISABLED_ID}, ${DISABLED_HANDLE}, ${hashPassword(PASSWORD)}, 'RDF', ${sql.array(['reviewer'])}, 'disabled')`;
  });
}

async function seedApplication(): Promise<void> {
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
    VALUES (${RDF_CAMPAIGN}, 'IAM-check RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
            now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;
  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RDF_APP}, ${RDF_CODE}, ${APPLICANT_ID}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT', 'SUBMITTED')`;
}

async function main(): Promise<void> {
  await cleanup();
  await seedOfficers();
  await seedApplication();

  // ── Boot iam-service (the issuer) ───────────────────────────────
  const iamBus = new InMemoryEventBus();
  const iamConfig = loadIamConfig();
  const iam = createIamService(iamConfig, iamBus);
  const iamServer = await startHttpServer({
    serviceName: 'iam-service-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: officerLoginRoutes(iam.login),
    handleSignals: false,
  });

  // ── Boot the REAL application-service officer read route (verifier) ──
  const appConfig = loadApplicationConfig();
  const appService = createApplicationService(appConfig, new InMemoryEventBus());
  const verify = makeAuthVerifier({
    publicKeyPem: appConfig.auth.authPublicKeyPem,
    issuer: appConfig.auth.jwtIssuer,
    audience: appConfig.auth.jwtAudience,
  });
  const appServer = await startHttpServer({
    serviceName: 'application-service-iam-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [listApplicationsRoute(appService.list, verify)],
    handleSignals: false,
  });

  console.log(`\niam-service at ${iamServer.url} · application-service at ${appServer.url}`);

  async function login(
    loginHandle: string,
    password: string,
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    const res = await fetch(`${iamServer.url}/v1/auth/officer/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginHandle, password }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return { status: res.status, text, json };
  }

  async function officerGet(token: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${appServer.url}${LIST_APPLICATIONS_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, text: await res.text() };
  }

  try {
    console.log('\n── 1. Officer login → 200 + token ──');
    const good = await login(HANDLE, PASSWORD);
    check('good login → 200', good.status === 200, `got ${good.status} ${good.text}`);
    const token = String(good.json['token'] ?? '');
    check('response carries a token', token.length > 0);
    check('token is a 4-part USRP-AUTH token', token.split('.').length === 4);
    check('response carries expiresAt', typeof good.json['expiresAt'] === 'string');
    check('login response contains NO password', !good.text.includes(PASSWORD));
    check('login response contains NO scrypt hash material', !good.text.includes('scrypt$'));

    console.log('\n── 2. Minted claims are correct ──');
    const principal = verifyAuthToken(appConfig.auth.authPublicKeyPem, token, {
      expectedIssuer: appConfig.auth.jwtIssuer,
      expectedAudience: appConfig.auth.jwtAudience,
    });
    check('token verifies with the app-service PUBLIC key', principal !== null);
    check('principal.kind == officer', principal?.kind === 'officer');
    check(
      'principal.subjectId == the officer UUID (Slice-4 stamp alignment)',
      principal?.kind === 'officer' && principal.subjectId === OFFICER_ID,
      String(principal?.kind === 'officer' ? principal.subjectId : ''),
    );
    check('principal.agency == RDF', principal?.kind === 'officer' && principal.agency === 'RDF');
    const expMs = Date.parse(String(good.json['expiresAt']));
    const ttlMs = expMs - Date.now();
    check(
      `expiry ≈ ${OFFICER_TOKEN_TTL_SECONDS}s out`,
      ttlMs > (OFFICER_TOKEN_TTL_SECONDS - 120) * 1000 && ttlMs <= OFFICER_TOKEN_TTL_SECONDS * 1000,
      `${Math.round(ttlMs / 1000)}s`,
    );

    console.log('\n── 3. THE LOOP-CLOSER: minted token accepted by the REAL officer endpoint ──');
    const listed = await officerGet(token);
    check('GET /v1/applications with the minted token → 200', listed.status === 200, `got ${listed.status} ${listed.text}`);
    check('officer sees their RDF application (agency scoped from the token)', listed.text.includes(RDF_CODE));
    check('officer listing leaks NO national_id_hash', !listed.text.includes(NID_HASH));

    console.log('\n── 4. No user-enumeration: bad password / unknown handle / disabled → identical 401 ──');
    const badPw = await login(HANDLE, WRONG_PASSWORD);
    const unknown = await login('no.such.officer', PASSWORD);
    const disabled = await login(DISABLED_HANDLE, PASSWORD);
    check('wrong password → 401', badPw.status === 401, `got ${badPw.status}`);
    check('unknown handle → 401', unknown.status === 401, `got ${unknown.status}`);
    check('disabled account → 401', disabled.status === 401, `got ${disabled.status}`);
    check(
      'all three 401s are byte-identical (no enumeration signal)',
      badPw.text === unknown.text && unknown.text === disabled.text,
      `${badPw.text} | ${unknown.text} | ${disabled.text}`,
    );
    check('a rejected login never echoes the password', !badPw.text.includes(WRONG_PASSWORD));

    console.log('\n── 5. Expired / tampered minted tokens rejected by the verifier ──');
    // Tamper: flip the FIRST char of the signature segment. (The LAST base64url
    // char of a 64-byte Ed25519 signature carries 4 padding bits that decode is
    // free to ignore, so flipping it can be a no-op; the first char's 6 bits are
    // always significant → a guaranteed-different signature.)
    const parts = token.split('.');
    const sig = parts[3] ?? '';
    const flipped = (sig.charAt(0) === 'A' ? 'B' : 'A') + sig.slice(1);
    const tampered = [parts[0], parts[1], parts[2], flipped].join('.');
    check('tampered token → 401 at the officer endpoint', (await officerGet(tampered)).status === 401);
    // Expired: mint the SAME officer's token with a clock 2 hours in the past
    // (injected into a throwaway OfficerLoginService with a stub repo).
    const expiredSvc = new OfficerLoginService(
      {
        findByHandle: async () => ({
          officerId: OFFICER_ID,
          loginHandle: HANDLE,
          credential: hashPassword(PASSWORD),
          agency: 'RDF' as const,
          roles: ['reviewer'],
          status: 'active' as const,
        }),
      },
      new InMemoryEventBus(),
      {
        privateKeyPem: iamConfig.issuer.authPrivateKeyPem,
        issuer: iamConfig.issuer.jwtIssuer,
        audience: iamConfig.issuer.jwtAudience,
        tokenTtlSeconds: OFFICER_TOKEN_TTL_SECONDS,
      },
      () => new Date(Date.now() - 2 * 60 * 60 * 1000),
    );
    const expiredOutcome = await expiredSvc.login({
      loginHandle: HANDLE,
      password: PASSWORD,
      context: { correlationId: 'x', causationId: 'x' },
    });
    const expiredToken = expiredOutcome.kind === 'AUTHENTICATED' ? expiredOutcome.token : '';
    check('an expired minted token → 401 at the officer endpoint', (await officerGet(expiredToken)).status === 401);

    console.log('\n── 6. The success AUDIT_ENTRY is PII-free (no password / hash) ──');
    const audit = iamBus.published.find((e) => e.eventType === 'AUDIT_ENTRY');
    check('a login AUDIT_ENTRY was emitted', audit !== undefined);
    const auditJson = JSON.stringify(audit ?? {});
    check('audit entityType == OFFICER', (audit as { entityType?: string } | undefined)?.entityType === 'OFFICER');
    check('audit performedBy == officer UUID', (audit as { performedBy?: string } | undefined)?.performedBy === OFFICER_ID);
    check('audit carries NO password', !auditJson.includes(PASSWORD));
    check('audit carries NO scrypt hash material', !auditJson.includes('scrypt$'));
    check('audit carries NO login handle (PII-free)', !auditJson.includes(HANDLE));
  } finally {
    await cleanup();
    await iamServer.stop();
    await appServer.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('IAM TOKEN ISSUER PROVEN (live) — issuer mints, existing endpoint accepts ✓');
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
