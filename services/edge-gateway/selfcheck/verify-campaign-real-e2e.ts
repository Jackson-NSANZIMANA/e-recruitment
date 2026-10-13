// BUILD-001 real IAM → Edge session → application-service → PostgreSQL proof.
//
// Unlike verify-campaign-http-boundary.ts, this does not stub either the
// session store or campaign upstream. It starts real in-process IAM, Edge, and
// application HTTP servers; IAM reads a real officer_accounts row, Edge writes
// its real persistent session, application-service verifies the signed token,
// and the campaign command commits through the real PostgreSQL repository/RLS
// functions. Every fixture lives in a uniquely named disposable database that
// is closed and dropped in finally, even when the proof fails.

import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createIamService, loadIamConfig, officerLoginRoutes } from '../../iam-service/src/index.js';
import {
  campaignControlRoutes,
  createApplicationService,
  loadApplicationConfig,
} from '../../application-service/src/index.js';
import { createEdgeGateway, loadEdgeGatewayConfig } from '../src/index.js';
import { makeAuthVerifier } from '@usrp/shared-auth';
import { InMemoryEventBus } from '@usrp/shared-events';
import { startHttpServer, type HttpServer } from '@usrp/shared-http';
import { hashPassword, generateDeviceKeyPair } from '@usrp/shared-security';
import { configureDatabase, sql } from '@usrp/shared-database';

const BASE_APPLICATION_DATABASE_URL = process.env['DATABASE_URL']
  ?? 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db';
const ADMIN_URL = process.env['ADMIN_DATABASE_URL']
  ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/shared-database/src/migrations');
const RLS_DIR = resolve(REPO_ROOT, 'packages/shared-database/src/rls');
const clusterAdmin = postgres(ADMIN_URL, { max: 1, prepare: false, onnotice: () => {} });
const runId = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const databaseName = `usrp_build001_http_${process.pid}_${runId.toLowerCase()}`;
const campaignCode = `BUILD001-E2E-${runId}`;
const tamperedCode = `BUILD001-TAMPER-${runId}`;
const reviewerCode = `BUILD001-REVIEWER-${runId}`;
const adminId = randomUUID();
const reviewerId = randomUUID();
const adminHandle = `build001-admin-${runId.toLowerCase()}`;
const reviewerHandle = `build001-reviewer-${runId.toLowerCase()}`;
const adminPassword = `BUILD001-admin-${randomUUID()}-test`;
const reviewerPassword = `BUILD001-reviewer-${randomUUID()}-test`;

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface EdgeSessionCredentials {
  readonly cookieHeader: string;
  readonly csrfToken: string;
}

function cookieValues(headers: Headers): Map<string, string> {
  const result = new Map<string, string>();
  const setCookies = headers.getSetCookie();
  const values = setCookies.length > 0
    ? setCookies
    : (headers.get('set-cookie') === null ? [] : [headers.get('set-cookie') as string]);
  for (const value of values) {
    const first = value.split(';', 1)[0];
    if (first === undefined) continue;
    const separator = first.indexOf('=');
    if (separator < 1) continue;
    result.set(first.slice(0, separator), first.slice(separator + 1));
  }
  return result;
}

function draftBody(code: string): Record<string, unknown> {
  return {
    publicCode: code,
    campaignLabel: `BUILD-001 real HTTP ${runId}`,
    targetCategories: ['GENERAL_ENLISTMENT'],
    targetDistricts: ['GASABO'],
    registrationOpensAt: '2030-01-01T08:00:00+02:00',
    registrationClosesAt: '2030-01-31T17:00:00+02:00',
    examinationStartDate: '2030-02-01',
    examinationEndDate: '2030-02-15',
    examinationReportingHour: 8,
    allowsWalkIn: false,
  };
}

async function bootstrapDisposableDatabase(database: ReturnType<typeof postgres>): Promise<void> {
  const drizzleFiles = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort();
  if (drizzleFiles.length === 0) throw new Error('no Drizzle SQL migrations found');
  for (const migration of drizzleFiles) {
    await database.unsafe(readFileSync(resolve(MIGRATIONS_DIR, migration), 'utf8'));
  }
  const rlsFiles = readdirSync(RLS_DIR)
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
    .sort();
  for (const migration of rlsFiles) {
    await database.unsafe(readFileSync(resolve(RLS_DIR, migration), 'utf8'));
  }
}

async function main(): Promise<void> {
  let iamServer: HttpServer | undefined;
  let appServer: HttpServer | undefined;
  let edgeServer: HttpServer | undefined;
  let proofDatabase: ReturnType<typeof postgres> | undefined;
  let databaseCreated = false;
  let sharedClientConfigured = false;
  const iamBus = new InMemoryEventBus();

  try {
    // The HTTP flow runs in a disposable, freshly migrated/RLS-bootstrapped
    // database. This permits a true first-admin account to be created without
    // touching existing agency admins or fixtures in the developer database.
    await clusterAdmin.unsafe(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const proofAdminUrl = new URL(ADMIN_URL);
    proofAdminUrl.pathname = `/${databaseName}`;
    // The RLS SQL files contain explicit BEGIN/COMMIT blocks. postgres.js
    // only permits those in `unsafe()` when this bootstrap client is pinned to
    // one connection; the runtime service pools remain independently sized.
    const proof = postgres(proofAdminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    proofDatabase = proof;
    await bootstrapDisposableDatabase(proof);

    const applicationUrl = new URL(BASE_APPLICATION_DATABASE_URL);
    applicationUrl.pathname = `/${databaseName}`;
    const applicationDatabaseUrl = applicationUrl.toString();
    process.env['DATABASE_URL'] = applicationDatabaseUrl;
    configureDatabase({ url: applicationDatabaseUrl, maxConnections: 12 });
    sharedClientConfigured = true;
    console.log(`\nReal IAM → Edge → application → PostgreSQL against disposable ${databaseName}`);

    const keyPair = generateDeviceKeyPair();
    const publicKeyB64 = Buffer.from(keyPair.publicKeyPem, 'utf8').toString('base64');
    const privateKeyB64 = Buffer.from(keyPair.privateKeyPem, 'utf8').toString('base64');

    const firstAdminReference = `BUILD001-SELF-CHECK-${runId}`;
    const firstAdminCorrelation = `BUILD001-HTTP-${runId}`;
    const provisioned = await proof.begin(async (tx) => {
      // Exercise the exact database function and asserted session identity in
      // an isolated database. SET LOCAL SESSION AUTHORIZATION from the admin
      // connection emulates the function's session_user check. It does NOT
      // prove direct provisioner-password authentication or independently
      // authenticate a human operator.
      await tx`SET LOCAL SESSION AUTHORIZATION usrp_iam_provisioner`;
      const identity = await tx<{ session_user: string; current_user: string }[]>`
        SELECT session_user, current_user
      `;
      const result = await tx<{ result: unknown }[]>`
        SELECT public_core.provision_first_campaign_agency_admin(
          ${adminId}::uuid,
          ${adminHandle},
          ${hashPassword(adminPassword)},
          'RDF'::public_core.agency,
          ${firstAdminReference},
          ${firstAdminCorrelation}
        ) AS result
      `;
      return {
        sessionUser: identity[0]?.session_user,
        currentUser: identity[0]?.current_user,
        result: result[0]?.result,
      };
    });
    check('first-admin function accepts the emulated usrp_iam_provisioner session identity in the isolated DB (not password authentication)',
      provisioned.sessionUser === 'usrp_iam_provisioner' &&
      provisioned.currentUser === 'usrp_iam_provisioner' && provisioned.result !== undefined);
    const firstAdminAudit = await proof<{ n: number; secret_fields: boolean }[]>`
      SELECT count(*)::int AS n,
             COALESCE(bool_or(payload ?| ARRAY['password', 'credential', 'loginHandle']), false) AS secret_fields
      FROM public_core.event_outbox
      WHERE producer = 'iam-service' AND event_type = 'AUDIT_ENTRY'
        AND payload->>'action' = 'FIRST_CAMPAIGN_AGENCY_ADMIN_PROVISIONED'
        AND payload->>'entityId' = ${adminId}
    `;
    check('provisioned admin has one credential-free first-admin audit event',
      firstAdminAudit[0]?.n === 1 && firstAdminAudit[0]?.secret_fields === false);

    await proof`
      INSERT INTO public_core.officer_accounts
        (officer_id, login_handle, credential, agency, roles, status)
      VALUES
        (${reviewerId}::uuid, ${reviewerHandle}, ${hashPassword(reviewerPassword)}, 'RDF', ARRAY['reviewer']::text[], 'active')
    `;

    const iamConfig = loadIamConfig({
      ...process.env,
      DATABASE_URL: applicationDatabaseUrl,
      AUTH_JWT_PRIVATE_KEY_B64: privateKeyB64,
      JWT_ISSUER: 'usrp',
      JWT_AUDIENCE: 'usrp-services',
    });
    const iam = createIamService(iamConfig, iamBus);
    await iamBus.connect();
    iamServer = await startHttpServer({
      serviceName: 'iam-build001-real-e2e',
      port: 0,
      host: '127.0.0.1',
      routes: officerLoginRoutes(iam.login),
      handleSignals: false,
      logger: () => {},
    });

    const appConfig = loadApplicationConfig({
      ...process.env,
      DATABASE_URL: applicationDatabaseUrl,
      AUTH_JWT_PUBLIC_KEY_B64: publicKeyB64,
      JWT_ISSUER: 'usrp',
      JWT_AUDIENCE: 'usrp-services',
    });
    const appService = createApplicationService(appConfig, new InMemoryEventBus());
    const verify = makeAuthVerifier({
      publicKeyPem: appConfig.auth.authPublicKeyPem,
      issuer: appConfig.auth.jwtIssuer,
      audience: appConfig.auth.jwtAudience,
    });
    appServer = await startHttpServer({
      serviceName: 'application-build001-real-e2e',
      port: 0,
      host: '127.0.0.1',
      routes: campaignControlRoutes(appService.campaignControl, verify),
      handleSignals: false,
      logger: () => {},
    });

    const edgeConfig = loadEdgeGatewayConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: applicationDatabaseUrl,
      EDGE_SESSION_HMAC_KEY: randomBytes(32).toString('hex'),
      EDGE_SESSION_IDLE_TTL_SECONDS: '600',
      EDGE_SESSION_ABSOLUTE_TTL_SECONDS: '1800',
      EDGE_COOKIE_SECURE: 'false',
      CORS_ORIGINS: 'https://build001.example.test',
      IAM_BASE_URL: iamServer.url,
      IDENTITY_SERVICE_BASE_URL: 'http://127.0.0.1:1',
      APPLICATION_SERVICE_BASE_URL: appServer.url,
      SCHEDULING_SERVICE_BASE_URL: 'http://127.0.0.1:1',
      FIELD_SYNC_SERVICE_BASE_URL: 'http://127.0.0.1:1',
      AUTH_JWT_PUBLIC_KEY_B64: publicKeyB64,
      JWT_ISSUER: 'usrp',
      JWT_AUDIENCE: 'usrp-services',
      EDGE_LOGIN_RATE_LIMIT_PER_MINUTE: '20',
    });
    const edge = createEdgeGateway(edgeConfig);
    edgeServer = await startHttpServer({
      serviceName: 'edge-build001-real-e2e',
      port: 0,
      host: '127.0.0.1',
      routes: edge.routes,
      cors: edge.cors,
      handleSignals: false,
      logger: () => {},
    });
    const edgeBaseUrl = edgeServer.url;

    console.log(`\nReal IAM ${iamServer.url} → Edge ${edgeBaseUrl} → application ${appServer.url}`);

    async function loginAtEdge(loginHandle: string, password: string): Promise<EdgeSessionCredentials> {
      const probe = await fetch(`${edgeBaseUrl}/edge/v1/session`);
      const probeCookies = cookieValues(probe.headers);
      const csrfToken = probeCookies.get(edge.deps.cookies.csrfCookieName);
      check('anonymous Edge probe creates the CSRF bootstrap cookie',
        probe.status === 401 && csrfToken !== undefined && csrfToken.length > 0);
      if (csrfToken === undefined) throw new Error('Edge CSRF bootstrap cookie missing');

      const login = await fetch(`${edgeBaseUrl}/edge/v1/auth/officer/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${edge.deps.cookies.csrfCookieName}=${csrfToken}`,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ loginHandle, password }),
      });
      const cookies = cookieValues(login.headers);
      const sessionHandle = cookies.get(edge.deps.cookies.sessionCookieName);
      const issuedCsrf = cookies.get(edge.deps.cookies.csrfCookieName);
      check('real IAM login through Edge returns 204 and sets opaque session + CSRF cookies',
        login.status === 204 && sessionHandle !== undefined && sessionHandle.length > 0 &&
        issuedCsrf !== undefined && issuedCsrf.length > 0 && login.headers.get('set-cookie')?.includes('HttpOnly') === true);
      if (sessionHandle === undefined || issuedCsrf === undefined) {
        throw new Error('Edge login did not issue both session cookies');
      }
      const cookieHeader = `${edge.deps.cookies.sessionCookieName}=${sessionHandle}; ${edge.deps.cookies.csrfCookieName}=${issuedCsrf}`;
      return { cookieHeader, csrfToken: issuedCsrf };
    }

    async function postCampaign(
      session: EdgeSessionCredentials,
      body: Record<string, unknown>,
      idempotencyKey = randomUUID(),
    ): Promise<Response> {
      return fetch(`${edgeBaseUrl}/edge/v1/campaigns`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: session.cookieHeader,
          'x-csrf-token': session.csrfToken,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    }

    const adminSession = await loginAtEdge(adminHandle, adminPassword);

    const sessionRead = await fetch(`${edgeBaseUrl}/edge/v1/session`, {
      headers: { cookie: adminSession.cookieHeader },
    });
    const sessionView = await sessionRead.json() as Record<string, unknown>;
    check('Edge session is persisted, exposes RDF agency_admin context, and redacts subject/session/token credentials',
      sessionRead.status === 200 && sessionView['kind'] === 'officer' &&
      sessionView['agency'] === 'RDF' &&
      Array.isArray(sessionView['roles']) && sessionView['roles'].includes('agency_admin') &&
      !Object.hasOwn(sessionView, 'subjectId') && !Object.hasOwn(sessionView, 'sessionId') &&
      !Object.hasOwn(sessionView, 'upstreamCredential') && !Object.hasOwn(sessionView, 'token'));

    const spoofed = await postCampaign(adminSession, {
      ...draftBody(tamperedCode),
      agency: 'RNP',
      actorId: reviewerId,
    });
    check('Edge rejects caller-supplied actor/agency substitution before dispatch',
      spoofed.status === 400 &&
      (await proof<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.recruitment_campaigns WHERE public_code = ${tamperedCode}`)[0]?.n === 0);

    const idemKey = randomUUID();
    const created = await postCampaign(adminSession, draftBody(campaignCode), idemKey);
    const createdBody = await created.json() as Record<string, unknown>;
    check('real IAM-authenticated Edge campaign draft returns 201',
      created.status === 201 && createdBody['publicCode'] === campaignCode && createdBody['campaignStatus'] === 'DRAFT');

    const replay = await postCampaign(adminSession, draftBody(campaignCode), idemKey);
    const replayBody = await replay.json() as Record<string, unknown>;
    check('retry across Edge → application → PostgreSQL replays the original response',
      replay.status === 201 && replay.headers.get('idempotency-replayed') === 'true' &&
      JSON.stringify(replayBody) === JSON.stringify(createdBody));

    const changedRequest = await postCampaign(adminSession, draftBody(`BUILD001-REUSED-${runId}`), idemKey);
    const changedBody = await changedRequest.json() as Record<string, unknown>;
    check('same actor/key with a changed request is rejected as an idempotency conflict',
      changedRequest.status === 409 && changedBody['error'] === 'IDEMPOTENCY_KEY_REUSED');

    const campaignRows = await proof<{
      id: string;
      agency: string;
      status: string;
      history_actor: string;
    }[]>`
      SELECT c.id::text AS id, c.agency::text AS agency, c.status::text AS status,
             h.actor_id::text AS history_actor
      FROM public_core.recruitment_campaigns c
      JOIN public_core.campaign_lifecycle_history h ON h.campaign_id = c.id
      WHERE c.public_code = ${campaignCode} AND h.to_status = 'DRAFT'
    `;
    const campaignEvents = await proof<{
      event_type: string;
      producer: string;
      performed_by: string | null;
      agency: string | null;
    }[]>`
      SELECT event_type, producer, payload->>'performedBy' AS performed_by,
             payload->>'agency' AS agency
      FROM public_core.event_outbox
      WHERE payload->>'publicCode' = ${campaignCode}
      ORDER BY event_type
    `;
    check('PostgreSQL records RDF DRAFT and actor history from the verified token subject',
      campaignRows.length === 1 && campaignRows[0]?.agency === 'RDF' &&
      campaignRows[0]?.status === 'DRAFT' && campaignRows[0]?.history_actor === adminId);
    check('one atomic domain event + audit event carry the verified actor and agency (no replay duplicates)',
      campaignEvents.length === 2 &&
      campaignEvents.every((event) => event.producer === 'application-service' && event.agency === 'RDF') &&
      campaignEvents.filter((event) => event.event_type === 'AUDIT_ENTRY' && event.performed_by === adminId).length === 1 &&
      campaignEvents.filter((event) => event.event_type === 'CAMPAIGN_DRAFT_CREATED').length === 1);

    const reviewerSession = await loginAtEdge(reviewerHandle, reviewerPassword);
    const reviewerAttempt = await postCampaign(reviewerSession, draftBody(reviewerCode));
    const reviewerBody = await reviewerAttempt.json() as Record<string, unknown>;
    check('reviewer session is denied by application campaign permissions',
      reviewerAttempt.status === 403 && reviewerBody['error'] === 'FORBIDDEN' &&
      (await proof<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.recruitment_campaigns WHERE public_code = ${reviewerCode}`)[0]?.n === 0);

    const logout = await fetch(`${edgeBaseUrl}/edge/v1/auth/officer/logout`, {
      method: 'POST',
      headers: {
        cookie: adminSession.cookieHeader,
        'x-csrf-token': adminSession.csrfToken,
      },
    });
    check('Edge logout revokes the persisted session after the real campaign flow', logout.status === 204);
  } catch (error) {
    fail += 1;
    console.error('  ✗ real IAM/Edge/application campaign flow crashed', error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error));
  } finally {
    if (edgeServer !== undefined) await edgeServer.stop().catch(() => {});
    if (appServer !== undefined) await appServer.stop().catch(() => {});
    if (iamServer !== undefined) await iamServer.stop().catch(() => {});
    await iamBus.disconnect().catch(() => {});

    if (sharedClientConfigured) await sql.end({ timeout: 5 }).catch(() => {});
    if (proofDatabase !== undefined) await proofDatabase.end({ timeout: 5 }).catch(() => {});
    if (databaseCreated) {
      try {
        await clusterAdmin.unsafe(`DROP DATABASE "${databaseName}"`);
      } catch (error) {
        fail += 1;
        console.error('  ✗ failed to drop disposable IAM/Edge proof database', error instanceof Error ? error.message : String(error));
      }
    }
    await clusterAdmin.end({ timeout: 5 }).catch(() => {});
  }

  console.log(`\nBUILD-001 REAL IAM → EDGE → APPLICATION → POSTGRESQL: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error('BUILD-001 real IAM/Edge proof crashed:', error);
  process.exitCode = 1;
});
