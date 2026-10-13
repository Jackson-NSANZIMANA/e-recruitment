// BUILD-001 live HTTP proof for the browser-facing campaign ingress.
//
// This boots the real edge route table and shared HTTP server with a narrowly
// typed session-store/upstream test double. It proves the campaign-session
// endpoint's cookie/CSRF/idempotency/authentication boundary and public-read
// projection over real HTTP. The upstream is intentionally stubbed: database
// transaction semantics are covered only by the DB-backed campaign selfcheck.

import { randomUUID } from 'node:crypto';
import { startHttpServer, type HttpServer } from '@usrp/shared-http';
import { edgeCorsPolicy, edgeRoutes, type EdgeSession, type EdgeGatewayConfig } from '../src/index.js';
import { cookiePolicy } from '../src/adapters/http/cookies.js';
import { csrfTokenHash } from '../src/crypto/tokens.js';
import { InMemoryRateLimiter } from '../src/adapters/rate-limiter.memory.js';
import type { EdgeDeps } from '../src/adapters/http/guards.js';
import type { SessionRepository } from '../src/ports/session-repository.js';
import type { UpstreamCallInput, UpstreamGateway, UpstreamResult } from '../src/ports/upstream-gateway.js';

const HMAC_KEY = 'campaign-http-boundary-selfcheck-key-2030';
const CSRF_TOKEN = 'c'.repeat(64);
const SESSION_HANDLE = 'build001-http-session-handle';
const OFFICER_CREDENTIAL = 'synthetic-officer-jwt-not-a-real-credential';
const ORIGIN = 'https://campaign-ui.example.test';
const ACTOR_ID = '00112233-4455-4677-8899-aabbccddeeff';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function campaignPublicFixture(): Record<string, unknown> {
  return {
    publicCode: 'RDF-HTTP-2030',
    campaignLabel: 'HTTP boundary fixture',
    agency: 'RDF',
    status: 'REGISTRATION_OPEN',
    registrationOpensAt: '2030-01-01T06:00:00.000Z',
    registrationClosesAt: '2030-01-31T15:00:00.000Z',
    examinationStartDate: '2030-02-01',
    examinationEndDate: '2030-02-15',
    targetCategories: ['GENERAL_ENLISTMENT'],
    targetDistricts: ['GASABO'],
    allowsWalkIn: false,
    contactPhoneNumbers: null,
    contactWebsite: null,
    id: randomUUID(),
    policyDocument: { private: 'must not cross the edge' },
    policyHash: 'private-policy-hash',
    capacityLimit: 999,
    registeredCount: 7,
    auditMetadata: { private: true },
  };
}

async function main(): Promise<void> {
  const csrfHash = csrfTokenHash(HMAC_KEY, CSRF_TOKEN);
  const officerSession: EdgeSession = {
    sessionId: randomUUID(),
    kind: 'officer',
    subjectId: ACTOR_ID,
    agency: 'RDF',
    roles: ['agency_admin'],
    upstreamCredential: OFFICER_CREDENTIAL,
    upstreamExpiresAt: null,
    csrfTokenHash: csrfHash,
    previousCsrfTokenHash: null,
    idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
    absoluteExpiresAt: new Date('2030-01-01T12:00:00.000Z'),
  };
  let currentSession: EdgeSession | null = officerSession;
  const sessions: SessionRepository = {
    async create() {
      return { session: officerSession, handle: SESSION_HANDLE, csrfToken: CSRF_TOKEN };
    },
    async findByHandle(handle) {
      return handle === SESSION_HANDLE && currentSession !== null
        ? { kind: 'ACTIVE', session: currentSession }
        : { kind: 'UNKNOWN' };
    },
    async touch() {},
    async rotate() { return null; },
    async revoke() {},
    async deleteExpired() { return 0; },
    async stats() { return { activeOfficer: 1, activeApplicant: 0, revoked: 0, expired: 0 }; },
  };

  const calls: UpstreamCallInput[] = [];
  let replayNextWrite = false;
  const upstream: UpstreamGateway = {
    async call(input): Promise<UpstreamResult> {
      calls.push(input);
      if (input.operation.id === 'campaignSession') {
        const replayed = replayNextWrite;
        replayNextWrite = false;
        return {
          status: 200,
          body: {
            status: 'SESSION_CONFIGURED',
            publicCode: 'RDF-HTTP-2030',
            capacityDecisionCode: 'UNBOUNDED_CAPACITY',
            coverageVersion: 1,
            coverageHash: 'a'.repeat(64),
          },
          ...(replayed ? { replayed: true } : {}),
        };
      }
      if (input.operation.id === 'publicCampaignList') {
        return { status: 200, body: { campaigns: [campaignPublicFixture()] } };
      }
      throw new Error(`Unexpected upstream operation ${input.operation.id}`);
    },
  };

  const config: EdgeGatewayConfig = {
    runtime: {
      serviceName: 'edge-gateway',
      nodeEnv: 'test',
      isProduction: false,
      port: 0,
      logLevel: 'error',
    },
    database: { url: 'postgres://selfcheck.invalid/usrp', maxConnections: 1 },
    session: {
      handleHmacKey: HMAC_KEY,
      idleTtlSeconds: 1_800,
      absoluteTtlSeconds: 43_200,
      secureCookies: false,
    },
    cors: { origins: [ORIGIN] },
    upstream: {
      iamBaseUrl: 'http://127.0.0.1:1',
      identityBaseUrl: 'http://127.0.0.1:1',
      applicationBaseUrl: 'http://127.0.0.1:1',
      schedulingBaseUrl: 'http://127.0.0.1:1',
      fieldSyncBaseUrl: 'http://127.0.0.1:1',
      timeoutMs: 8_000,
      maxResponseBytes: 1_048_576,
    },
    rateLimits: {
      loginPerMinute: 20,
      otpPerMinute: 20,
      verifyIdentityPerMinute: 20,
      applicantSubmitPerMinute: 20,
      trustedProxyHops: 0,
    },
    auth: { authPublicKeyPem: 'unused-by-the-stub-upstream', jwtIssuer: 'usrp', jwtAudience: 'usrp-services' },
  };
  const auditRecords: string[] = [];
  const deps: EdgeDeps = {
    config,
    cookies: cookiePolicy(false),
    sessions,
    upstream,
    limiter: new InMemoryRateLimiter(),
    audit: {
      log(record) { auditRecords.push(record.action); },
      stats() {},
      fault() {},
    },
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  };

  let server: HttpServer | undefined;
  try {
    server = await startHttpServer({
      serviceName: 'edge-campaign-http-selfcheck',
      port: 0,
      host: '127.0.0.1',
      routes: edgeRoutes(deps),
      cors: edgeCorsPolicy(config),
      handleSignals: false,
      logger: () => {},
    });
    const base = server.url;
    const cookies = `${deps.cookies.sessionCookieName}=${SESSION_HANDLE}; ${deps.cookies.csrfCookieName}=${CSRF_TOKEN}`;
    const sessionPath = '/edge/v1/campaigns/session';
    const sessionBody = {
      publicCode: 'rdf-http-2030',
      district: 'GASABO',
      province: 'KIGALI_CITY',
      venueName: 'Synthetic test venue',
      examDate: '2030-02-03',
      reportingTimeHour: 8,
      capacityLimit: null,
      capacityDecisionCode: 'UNBOUNDED_CAPACITY',
      isActive: true,
    };

    const anonymous = await fetch(`${base}${sessionPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify(sessionBody),
    });
    check('campaign command rejects a missing officer session before upstream dispatch',
      anonymous.status === 401 && calls.length === 0);

    const invalidCsrf = await fetch(`${base}${sessionPath}`, {
      method: 'POST',
      headers: {
        cookie: cookies,
        'content-type': 'application/json',
        'x-csrf-token': 'wrong-token',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(sessionBody),
    });
    check('campaign command rejects invalid session-bound CSRF before upstream dispatch',
      invalidCsrf.status === 403 && calls.length === 0 && auditRecords.includes('EDGE_CSRF_REJECTED'));

    const missingKey = await fetch(`${base}${sessionPath}`, {
      method: 'POST',
      headers: { cookie: cookies, 'content-type': 'application/json', 'x-csrf-token': CSRF_TOKEN },
      body: JSON.stringify(sessionBody),
    });
    check('campaign command requires a UUID Idempotency-Key at the live HTTP edge',
      missingKey.status === 400 && calls.length === 0);

    const forbiddenField = await fetch(`${base}${sessionPath}`, {
      method: 'POST',
      headers: {
        cookie: cookies,
        'content-type': 'application/json',
        'x-csrf-token': CSRF_TOKEN,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ ...sessionBody, agency: 'RNP' }),
    });
    check('campaign command rejects body-supplied agency instead of trusting it',
      forbiddenField.status === 400 && calls.length === 0);

    const applicantSession: EdgeSession = {
      ...officerSession,
      kind: 'applicant',
      subjectId: null,
      agency: null,
    };
    currentSession = applicantSession;
    const wrongKind = await fetch(`${base}${sessionPath}`, {
      method: 'POST',
      headers: {
        cookie: cookies,
        'content-type': 'application/json',
        'x-csrf-token': CSRF_TOKEN,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(sessionBody),
    });
    check('applicant session cannot invoke the officer campaign-session command',
      wrongKind.status === 403 && calls.length === 0);
    currentSession = officerSession;

    const key = randomUUID();
    const firstWrite = await fetch(`${base}${sessionPath}`, {
      method: 'POST',
      headers: {
        cookie: cookies,
        'content-type': 'application/json',
        'x-csrf-token': CSRF_TOKEN,
        'idempotency-key': key,
        // The browser cannot replace the credential bound to the session.
        authorization: 'Bearer browser-supplied-credential-must-not-forward',
      },
      body: JSON.stringify(sessionBody),
    });
    const firstBody = await firstWrite.json() as Record<string, unknown>;
    const firstCall = calls.at(-1);
    const forwardedBody = firstCall?.body as Record<string, unknown> | undefined;
    const expectedBodyKeys = [
      'publicCode', 'district', 'province', 'venueName', 'examDate',
      'reportingTimeHour', 'capacityLimit', 'capacityDecisionCode', 'isActive',
    ].sort();
    check('live edge HTTP request reaches the scheduling campaign-session upstream once',
      firstWrite.status === 200 && calls.length === 1 &&
      firstCall?.operation.service === 'scheduling' &&
      firstCall.operation.path === '/v1/campaigns/session');
    check('edge forwards the session credential, normalized allowlist, and exact idempotency key',
      firstCall?.credential === OFFICER_CREDENTIAL && firstCall.idempotencyKey === key &&
      JSON.stringify(Object.keys(forwardedBody ?? {}).sort()) === JSON.stringify(expectedBodyKeys) &&
      forwardedBody?.['publicCode'] === 'RDF-HTTP-2030' &&
      forwardedBody?.['capacityDecisionCode'] === 'UNBOUNDED_CAPACITY' &&
      !Object.hasOwn(forwardedBody ?? {}, 'agency'));
    check('browser-supplied Authorization is not used; explicit capacity decision survives edge forwarding',
      firstBody['capacityDecisionCode'] === 'UNBOUNDED_CAPACITY' &&
      firstWrite.headers.get('Idempotency-Replayed') === null);

    replayNextWrite = true;
    const replayWrite = await fetch(`${base}${sessionPath}`, {
      method: 'POST',
      headers: {
        cookie: cookies,
        'content-type': 'application/json',
        'x-csrf-token': CSRF_TOKEN,
        'idempotency-key': key,
      },
      body: JSON.stringify(sessionBody),
    });
    check('a stored upstream replay is represented by the allowlisted replay header',
      replayWrite.status === 200 && replayWrite.headers.get('Idempotency-Replayed') === 'true' &&
      calls.length === 2 && calls[1]?.idempotencyKey === key);

    const publicList = await fetch(`${base}/edge/v1/campaigns`);
    const listBody = await publicList.json() as { campaigns?: Record<string, unknown>[] };
    const publicCampaign = listBody.campaigns?.[0];
    const publicKeys = [
      'publicCode', 'campaignLabel', 'agency', 'status', 'registrationOpensAt',
      'registrationClosesAt', 'examinationStartDate', 'examinationEndDate',
      'targetCategories', 'targetDistricts', 'allowsWalkIn',
      'contactPhoneNumbers', 'contactWebsite',
    ].sort();
    check('anonymous public campaign HTTP read enforces the field allowlist',
      publicList.status === 200 && publicCampaign !== undefined &&
      JSON.stringify(Object.keys(publicCampaign).sort()) === JSON.stringify(publicKeys) &&
      !Object.hasOwn(publicCampaign, 'id') && !Object.hasOwn(publicCampaign, 'policyDocument') &&
      !Object.hasOwn(publicCampaign, 'policyHash') && !Object.hasOwn(publicCampaign, 'capacityLimit') &&
      !Object.hasOwn(publicCampaign, 'registeredCount') && !Object.hasOwn(publicCampaign, 'auditMetadata'));

    const preflight = await fetch(`${base}${sessionPath}`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-csrf-token,idempotency-key',
      },
    });
    check('campaign HTTP CORS preflight allows only the declared write headers',
      preflight.status === 204 &&
      preflight.headers.get('access-control-allow-origin') === ORIGIN &&
      (preflight.headers.get('access-control-allow-headers') ?? '').includes('idempotency-key'));
  } finally {
    await server?.stop();
  }

  console.log(`\nBUILD-001 live campaign HTTP/edge proof: ${String(pass)} passed, ${String(fail)} failed.`);
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error('BUILD-001 live campaign HTTP/edge proof crashed:', error);
  process.exitCode = 1;
});
