// ══════════════════════════════════════════════════════════════════
// iam-service — Live service-token (client-credentials) self-check
//
// Proves ADR-016 end-to-end against live infra: a kind:'system' token MINTED
// by iam-service via client-credentials is ACCEPTED by a REAL system front
// door — application-service's POST /v1/applications, booted in-proc. Until
// this slice no system token was ever minted outside a proof; this closes
// the machine half of the auth story the officer issuer closed for humans.
//
// What it asserts:
//   • seed a service account AS usrp_iam_service (proves the rls/0015 grant
//     + FORCE'd RLS WITH CHECK policy — not the admin escape hatch);
//   • POST /v1/auth/service/token (good creds) → 200 + a token;
//   • minted claims correct (sub = service UUID, kind = system, NO agency
//     key, ~15 min expiry — owner D3);
//   • LOOP-CLOSER: that token on POST /v1/applications (real app-service
//     system route) → 201 SUBMITTED;
//   • NEGATIVE loop-closer: the SAME system token on the officer-only
//     GET /v1/applications → 403 (kind gate, not just signature check);
//   • wrong secret / unknown client / disabled client → byte-identical 401
//     (no enumeration);
//   • an EXPIRED minted token is rejected by the consuming route (→ 401);
//   • a TAMPERED token is rejected (→ 401);
//   • exactly ONE SYSTEM_TOKEN_ISSUED audit (agency 'SYSTEM'), none for the
//     failed attempts; NO secret / digest / clientId in any response or event;
//   • regression guard: officer login still mints and works.
//
//   Run (repo root), Tier-1 up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/iam-service/selfcheck/verify-service-token-slice.ts
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
  submitApplicationRoute,
  listApplicationsRoute,
  SUBMIT_APPLICATION_PATH,
  LIST_APPLICATIONS_PATH,
} from '@usrp/application-service';

// ── One in-test issuer keypair, shared by both sides ──────────────
// iam-service MINTS with the private key; application-service VERIFIES with
// the public key — the production trust split, both halves held by the proof.
const KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PRIVATE_KEY_B64'] = Buffer.from(KEYS.privateKeyPem, 'utf8').toString('base64');
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

// Import iam-service AFTER the env is set (config validates the key at load).
const {
  createIamService,
  loadIamConfig,
  officerLoginRoutes,
  serviceTokenRoutes,
  ServiceTokenService,
  SERVICE_TOKEN_PATH,
  SYSTEM_TOKEN_TTL_SECONDS,
} = await import('../src/index.js');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Deterministic fixtures (5e70c11e — unique to this proof) ──────
const SERVICE_ID = '5e70c11e-0000-4000-8000-00000000c001'; // UUID → token sub
const DISABLED_SERVICE_ID = '5e70c11e-0000-4000-8000-00000000c002';
const CLIENT_ID = 'selfcheck.pipeline';
const DISABLED_CLIENT_ID = 'selfcheck.disabled.pipeline';
const SECRET = 'S3lfcheck#Service!';
const WRONG_SECRET = 'not-the-secret';

// Regression-guard officer (login must keep working alongside the new route).
const OFFICER_ID = '5e70c11e-0000-4000-8000-00000000a001';
const HANDLE = 'selfcheck.token.officer';
const PASSWORD = 'S3lfcheck#Officer!';

// One VERIFIED applicant + open RDF campaign so the loop-closer submit lands.
const APPLICANT_ID = '5e70c11e-1111-4111-8111-111111111111';
const NID_HASH = '5e70c11e'.repeat(8); // 64 hex
const RDF_CAMPAIGN = '5e70c11e-2222-4222-8222-222222222222';

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
    await tx`DELETE FROM public_core.service_accounts WHERE client_id IN ${tx([CLIENT_ID, DISABLED_CLIENT_ID])}`;
    await tx`DELETE FROM public_core.officer_accounts WHERE login_handle = ${HANDLE}`;
  });
}

async function seedAccounts(): Promise<void> {
  // Seed AS usrp_iam_service — proves the rls/0015 grant + WITH CHECK policy
  // on the service credential store (not via the admin superuser escape hatch).
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${sql('usrp_iam_service')}`;
    await tx`
      INSERT INTO public_core.service_accounts (service_id, client_id, credential, description, status)
      VALUES
        (${SERVICE_ID}, ${CLIENT_ID}, ${hashPassword(SECRET)}, 'selfcheck client', 'active'),
        (${DISABLED_SERVICE_ID}, ${DISABLED_CLIENT_ID}, ${hashPassword(SECRET)}, 'selfcheck disabled', 'disabled')`;
    await tx`
      INSERT INTO public_core.officer_accounts (officer_id, login_handle, credential, agency, roles, status)
      VALUES (${OFFICER_ID}, ${HANDLE}, ${hashPassword(PASSWORD)}, 'RDF', ${sql.array(['reviewer'])}, 'active')`;
  });
}

async function seedApplicant(): Promise<void> {
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
    VALUES (${RDF_CAMPAIGN}, 'Svc-token-check RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
            now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;
}

async function main(): Promise<void> {
  await cleanup();
  await seedAccounts();
  await seedApplicant();

  // ── Boot iam-service (the issuer: BOTH routes — token + login regression) ──
  const iamBus = new InMemoryEventBus();
  const iamConfig = loadIamConfig();
  const iam = createIamService(iamConfig, iamBus);
  const iamServer = await startHttpServer({
    serviceName: 'iam-service-svc-token-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [...serviceTokenRoutes(iam.serviceToken), ...officerLoginRoutes(iam.login)],
    handleSignals: false,
  });

  // ── Boot the REAL application-service front doors (the verifiers) ──
  // submit is kind:'system' (the positive loop-closer); list is
  // kind:'officer' (the negative one — a system token must bounce off it).
  const appConfig = loadApplicationConfig();
  const appService = createApplicationService(appConfig, new InMemoryEventBus());
  const verify = makeAuthVerifier({
    publicKeyPem: appConfig.auth.authPublicKeyPem,
    issuer: appConfig.auth.jwtIssuer,
    audience: appConfig.auth.jwtAudience,
  });
  const appServer = await startHttpServer({
    serviceName: 'application-service-svc-token-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [
      submitApplicationRoute(appService.submit, verify),
      listApplicationsRoute(appService.list, verify),
    ],
    handleSignals: false,
  });

  console.log(`\niam-service at ${iamServer.url} · application-service at ${appServer.url}`);

  async function requestToken(
    clientId: string,
    clientSecret: string,
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    const res = await fetch(`${iamServer.url}${SERVICE_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
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

  async function submitWith(token: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${appServer.url}${SUBMIT_APPLICATION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        applicantId: APPLICANT_ID,
        category: 'GENERAL_ENLISTMENT',
        channel: 'WEB',
        nesaIndexNumber: 'RW2024/1001',
      }),
    });
    return { status: res.status, text: await res.text() };
  }

  try {
    console.log('\n── 1. Client-credentials → 200 + token ──');
    const good = await requestToken(CLIENT_ID, SECRET);
    check('good credentials → 200', good.status === 200, `got ${good.status} ${good.text}`);
    const token = String(good.json['token'] ?? '');
    check('response carries a token', token.length > 0);
    check('token is a 4-part USRP-AUTH token', token.split('.').length === 4);
    check('response carries expiresAt', typeof good.json['expiresAt'] === 'string');
    check('response contains NO secret', !good.text.includes(SECRET));
    check('response contains NO scrypt hash material', !good.text.includes('scrypt$'));

    console.log('\n── 2. Minted claims: system principal, D3 TTL ──');
    const principal = verifyAuthToken(appConfig.auth.authPublicKeyPem, token, {
      expectedIssuer: appConfig.auth.jwtIssuer,
      expectedAudience: appConfig.auth.jwtAudience,
    });
    check('token verifies with the app-service PUBLIC key', principal !== null);
    check('principal.kind == system', principal?.kind === 'system');
    check(
      'principal.subjectId == the service UUID',
      principal?.subjectId === SERVICE_ID,
      String(principal?.subjectId ?? ''),
    );
    check('principal carries NO agency (cross-agency by kind)', !('agency' in (principal ?? {})));
    const expMs = Date.parse(String(good.json['expiresAt']));
    const ttlMs = expMs - Date.now();
    check(
      `expiry ≈ ${SYSTEM_TOKEN_TTL_SECONDS}s out (owner D3: 15 min)`,
      ttlMs > (SYSTEM_TOKEN_TTL_SECONDS - 120) * 1000 && ttlMs <= SYSTEM_TOKEN_TTL_SECONDS * 1000,
      `${Math.round(ttlMs / 1000)}s`,
    );

    console.log('\n── 3. THE LOOP-CLOSER: system token accepted by the REAL submit route ──');
    const submitted = await submitWith(token);
    check(
      'POST /v1/applications with the minted token → 201 SUBMITTED',
      submitted.status === 201 && submitted.text.includes('"SUBMITTED"'),
      `got ${submitted.status} ${submitted.text}`,
    );
    check('submit response leaks NO national_id_hash', !submitted.text.includes(NID_HASH));

    console.log('\n── 4. NEGATIVE loop-closer: system token on an OFFICER-only route → 403 ──');
    const officerOnly = await fetch(`${appServer.url}${LIST_APPLICATIONS_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    check('GET /v1/applications (officer-only) with a system token → 403', officerOnly.status === 403, `got ${officerOnly.status}`);

    console.log('\n── 5. No enumeration: wrong secret / unknown / disabled → identical 401 ──');
    const badSecret = await requestToken(CLIENT_ID, WRONG_SECRET);
    const unknown = await requestToken('no.such.client', SECRET);
    const disabled = await requestToken(DISABLED_CLIENT_ID, SECRET);
    check('wrong secret → 401', badSecret.status === 401, `got ${badSecret.status}`);
    check('unknown client → 401', unknown.status === 401, `got ${unknown.status}`);
    check('disabled client → 401', disabled.status === 401, `got ${disabled.status}`);
    check(
      'all three 401s are byte-identical (no enumeration signal)',
      badSecret.text === unknown.text && unknown.text === disabled.text,
      `${badSecret.text} | ${unknown.text} | ${disabled.text}`,
    );
    check('a rejected request never echoes the secret', !badSecret.text.includes(WRONG_SECRET));

    console.log('\n── 6. Expired / tampered minted tokens rejected by the consuming route ──');
    // Tamper: flip the FIRST char of the signature segment (always significant).
    const parts = token.split('.');
    const sig = parts[3] ?? '';
    const tampered = [parts[0], parts[1], parts[2], (sig.charAt(0) === 'A' ? 'B' : 'A') + sig.slice(1)].join('.');
    check('tampered token → 401 at the submit route', (await submitWith(tampered)).status === 401);
    // Expired: mint the SAME client's token with a clock 2 hours in the past
    // (injected into a throwaway ServiceTokenService with a stub repo).
    const expiredSvc = new ServiceTokenService(
      {
        findByClientId: async () => ({
          serviceId: SERVICE_ID,
          clientId: CLIENT_ID,
          credential: hashPassword(SECRET),
          status: 'active' as const,
        }),
      },
      new InMemoryEventBus(),
      {
        privateKeyPem: iamConfig.issuer.authPrivateKeyPem,
        issuer: iamConfig.issuer.jwtIssuer,
        audience: iamConfig.issuer.jwtAudience,
        tokenTtlSeconds: SYSTEM_TOKEN_TTL_SECONDS,
      },
      () => new Date(Date.now() - 2 * 60 * 60 * 1000),
    );
    const expiredOutcome = await expiredSvc.issue({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      context: { correlationId: 'x', causationId: 'x' },
    });
    const expiredToken = expiredOutcome.kind === 'ISSUED' ? expiredOutcome.token : '';
    check('an expired minted token → 401 at the submit route', (await submitWith(expiredToken)).status === 401);

    console.log('\n── 7. Audit: exactly one SYSTEM_TOKEN_ISSUED, secret-free; none on failures ──');
    const issuedAudits = iamBus.published.filter(
      (e) => e.eventType === 'AUDIT_ENTRY' && (e as { action?: string }).action === 'SYSTEM_TOKEN_ISSUED',
    );
    check(
      'exactly ONE SYSTEM_TOKEN_ISSUED (the success; failed attempts emit none)',
      issuedAudits.length === 1,
      `got ${issuedAudits.length}`,
    );
    const audit = issuedAudits[0] as { entityType?: string; performedBy?: string; agency?: string } | undefined;
    check('audit entityType == SYSTEM', audit?.entityType === 'SYSTEM');
    check('audit agency == SYSTEM', audit?.agency === 'SYSTEM');
    check('audit performedBy == service UUID', audit?.performedBy === SERVICE_ID);
    const allEventsJson = JSON.stringify(iamBus.published);
    check('NO event carries the secret', !allEventsJson.includes(SECRET));
    check('NO event carries scrypt hash material', !allEventsJson.includes('scrypt$'));
    check('NO event carries the clientId (metadata is method-only)', !allEventsJson.includes(CLIENT_ID));

    console.log('\n── 8. Regression guard: officer login still mints ──');
    const loginRes = await fetch(`${iamServer.url}/v1/auth/officer/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginHandle: HANDLE, password: PASSWORD }),
    });
    const loginText = await loginRes.text();
    check('officer login → 200 with a token', loginRes.status === 200 && loginText.includes('"token"'), `got ${loginRes.status}`);
  } finally {
    await cleanup();
    await iamServer.stop();
    await appServer.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('SERVICE-TOKEN ISSUANCE PROVEN (live) — client-credentials mints, system route accepts ✓');
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
