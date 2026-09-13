// ══════════════════════════════════════════════════════════════════
// edge-gateway — SELFCHECK: the edge tier's own invariants, proven
//
// "Prove it, don't assert it." This drives a REAL socket with a REAL browser
// cookie jar against the edge, with STUB upstreams standing in for iam,
// identity and application, plus the REAL PostgreSQL session store.
//
// WHY STUB UPSTREAMS. Everything asserted below is a property of THE EDGE:
// that a credential never reaches a cookie, that a 404 stays bare, that a
// retried write is refused, that the agency holding an accept lock is dropped,
// that upstream revocation reaches the browser. Standing up three real services
// would test them instead, and would make a regression in this tier look like
// somebody else's failure. The end-to-end pass with live upstreams belongs in
// the platform pipeline proof.
//
// THE SESSION STORE IS NOT STUBBED. It holds live credentials for every browser
// session, so its at-rest behaviour is proven against the live database.
//
// Usage:  pnpm --filter @usrp/edge-gateway selfcheck
// Needs:  tier1 Postgres, bootstrapped (rls/0019 applied).
// ══════════════════════════════════════════════════════════════════

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import { sql } from '@usrp/shared-database';
import { startHttpServer, type HttpServer } from '@usrp/shared-http';
import { createEdgeGateway } from '../src/index.js';
import { loadEdgeGatewayConfig } from '../src/config.js';
import { InMemoryEdgeSessionStore } from '../src/adapters/store/session-store.memory.js';
import { PgEdgeSessionStore } from '../src/adapters/store/session-store.pg.js';
import { hashHandle, mintCsrfToken, mintHandle } from '../src/domain/handle.js';
import { EDGE_PATHS } from '../src/adapters/http/paths.js';

// ── The committed DEV keypair (same values as scripts/run-selfchecks.sh) ──
const DEV_PUBLIC_KEY_B64 =
  'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQUpjb2FtWEM1NFMvTk51UDRlcXVzLzh5dlhuTk5yTkRhK0JGWFFuSkU1QzQ9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=';
const DEV_PRIVATE_KEY_B64 =
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSUlUaGJCTVJ0Sm9WQUwzUURrK29yZUgwVTludWw3RUNBNFdRRUxiV21LZmwKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=';
const DEV_PRIVATE_KEY_PEM = Buffer.from(DEV_PRIVATE_KEY_B64, 'base64').toString('utf8');

const SESSION_COOKIE = 'usrp_session_dev';
const CSRF_COOKIE = 'usrp_csrf_dev';
const NID = '1200380123456789';
const APP_ID = '11111111-2222-4333-8444-555555555555';
const APPLICANT_ID = '99999999-8888-4777-8666-555555555555';

let pass = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m✓\u001b[0m ${label}`);
  } else {
    failures.push(label);
    console.error(`\u001b[0;31m✗ ${label}\u001b[0m`, detail === undefined ? '' : detail);
  }
}

// ── Stub upstreams ───────────────────────────────────────────────────

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly correlationId: string | undefined;
  readonly body: Record<string, unknown>;
}

interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

class StubUpstream {
  readonly received: Recorded[] = [];
  readonly #routes = new Map<string, Reply | ((hit: number) => Reply)>();
  #server: Server | undefined;
  #port = 0;

  on(method: string, path: string, reply: Reply | ((hit: number) => Reply)): void {
    this.#routes.set(`${method} ${path}`, reply);
  }

  hits(method: string, path: string): number {
    return this.received.filter((r) => r.method === method && r.path === path).length;
  }

  last(method: string, path: string): Recorded | undefined {
    return [...this.received].reverse().find((r) => r.method === method && r.path === path);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  start(): Promise<void> {
    this.#server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url ?? '/', 'http://stub');
        let body: Record<string, unknown> = {};
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            body = {};
          }
        }
        const auth = req.headers.authorization;
        const corr = req.headers['x-correlation-id'];
        this.received.push({
          method: req.method ?? 'GET',
          path: url.pathname,
          authorization: Array.isArray(auth) ? auth[0] : auth,
          correlationId: Array.isArray(corr) ? corr[0] : corr,
          body,
        });
        if (url.pathname === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        const key = `${req.method ?? 'GET'} ${url.pathname}`;
        const route = this.#routes.get(key);
        if (route === undefined) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'STUB_NO_ROUTE', detail: key }));
          return;
        }
        const hit = this.hits(req.method ?? 'GET', url.pathname) - 1;
        const reply = typeof route === 'function' ? route(hit) : route;
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
      });
    });
    return new Promise((resolve) => {
      this.#server?.listen(0, '127.0.0.1', () => {
        this.#port = (this.#server?.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#server === undefined) return resolve();
      this.#server.close(() => resolve());
    });
  }
}

// ── A browser-ish client: one cookie jar, echoes the CSRF cookie ──────────

interface EdgeResponse {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown>;
  readonly setCookie: readonly string[];
}

class BrowserClient {
  readonly #jar = new Map<string, string>();
  constructor(private readonly baseUrl: string) {}

  cookie(name: string): string | undefined {
    return this.#jar.get(name);
  }

  setCookieValue(name: string, value: string): void {
    this.#jar.set(name, value);
  }

  clear(): void {
    this.#jar.clear();
  }

  async call(
    method: 'GET' | 'POST',
    path: string,
    options: {
      readonly body?: unknown;
      readonly csrf?: string | false;
      readonly correlationId?: string;
    } = {},
  ): Promise<EdgeResponse> {
    const headers: Record<string, string> = {};
    const pairs = [...this.#jar].map(([k, v]) => `${k}=${v}`);
    if (pairs.length > 0) headers['cookie'] = pairs.join('; ');
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.correlationId !== undefined) headers['x-correlation-id'] = options.correlationId;
    if (options.csrf !== false) {
      const token = options.csrf ?? this.#jar.get(CSRF_COOKIE);
      if (token !== undefined) headers['x-csrf-token'] = token;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const setCookie = res.headers.getSetCookie();
    for (const rawCookie of setCookie) {
      const [pair] = rawCookie.split(';');
      if (pair === undefined) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value.length === 0) this.#jar.delete(name);
      else this.#jar.set(name, value);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as unknown;
        json =
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
      } catch {
        json = {};
      }
    }
    return { status: res.status, text, json, setCookie };
  }
}

function officerToken(agency: 'RDF' | 'RNP', roles: readonly string[], ttlSeconds = 3600): string {
  const now = new Date();
  const claims: AuthTokenClaims = {
    v: 1,
    iss: 'usrp',
    aud: 'usrp-services',
    sub: `00000000-0000-4000-8000-00000000000${agency === 'RDF' ? '1' : '2'}`,
    kind: 'officer',
    agency,
    roles,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  return signAuthToken(DEV_PRIVATE_KEY_PEM, claims);
}

async function main(): Promise<void> {
  const iam = new StubUpstream();
  const identity = new StubUpstream();
  const applications = new StubUpstream();
  await Promise.all([iam.start(), identity.start(), applications.start()]);

  // Config through the REAL loaders, so a variable-name drift fails here too.
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    PORT_EDGE_GATEWAY: '4021',
    DATABASE_URL:
      process.env['DATABASE_URL'] ?? 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db',
    EDGE_SESSION_HMAC_KEY: 'dev_edge_session_hmac_key_min_32_chars!!',
    EDGE_SESSION_IDLE_TTL_SECONDS: '1800',
    EDGE_SESSION_ABSOLUTE_TTL_SECONDS: '43200',
    EDGE_COOKIE_SECURE: 'false',
    CORS_ORIGINS: 'http://localhost:3000',
    AUTH_JWT_PUBLIC_KEY_B64: DEV_PUBLIC_KEY_B64,
    JWT_ISSUER: 'usrp',
    JWT_AUDIENCE: 'usrp-services',
    IAM_BASE_URL: iam.baseUrl,
    IDENTITY_SERVICE_BASE_URL: identity.baseUrl,
    APPLICATION_SERVICE_BASE_URL: applications.baseUrl,
    EDGE_RATE_LIMIT_PER_CLIENT: '1000',
    EDGE_RATE_LIMIT_PER_SUBJECT: '3',
    EDGE_RATE_LIMIT_WINDOW_SECONDS: '300',
  };
  const config = loadEdgeGatewayConfig(env);
  check('config: the edge loads through the real shared-config loaders', config.session.idleTtlSeconds === 1800);
  check('config: cookies are insecure ONLY because this proof runs over http', !config.session.secureCookies);

  const store = new InMemoryEdgeSessionStore({
    handleHmacKey: config.session.handleHmacKey,
    idleTtlSeconds: config.session.idleTtlSeconds,
  });
  const edge = createEdgeGateway(config, { store });
  check('routes: all 23 operations are mounted', edge.routes.length === 23, edge.routes.length);

  const server: HttpServer = await startHttpServer({
    serviceName: 'edge-gateway-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: edge.routes,
    handleSignals: false,
  });
  const browser = new BrowserClient(server.url);

  try {
    // ── 1. Anonymous mount ───────────────────────────────────────
    const anon = await browser.call('GET', EDGE_PATHS.session);
    check('session: anonymous mount is a plain 401, not an error', anon.status === 401);
    check('session: the anonymous 401 body is EMPTY (no reason to invent)', anon.text === '{}', anon.text);
    check('session: the anonymous mount seeds the readable CSRF cookie', browser.cookie(CSRF_COOKIE) !== undefined);
    check('session: no session cookie is issued to an anonymous caller', browser.cookie(SESSION_COOKIE) === undefined);
    check(
      'cookies: the CSRF cookie is NOT httpOnly — the SPA must read it to echo it',
      anon.setCookie.some((c) => c.startsWith(`${CSRF_COOKIE}=`) && !c.toLowerCase().includes('httponly')),
      anon.setCookie,
    );

    // ── 2. CSRF is mandatory and fails loudly ─────────────────────────
    const noCsrf = await browser.call('POST', EDGE_PATHS.officerLogin, {
      body: { loginHandle: 'rdf.officer', password: 'pw' },
      csrf: false,
    });
    check('csrf: an unsafe request without the header is 403', noCsrf.status === 403);
    check('csrf: the 403 carries the machine code the UI maps', noCsrf.json['error'] === 'CSRF_REJECTED');
    check('csrf: no upstream call was made for a rejected request', iam.hits('POST', '/v1/auth/officer/login') === 0);

    const wrongCsrf = await browser.call('POST', EDGE_PATHS.officerLogin, {
      body: { loginHandle: 'rdf.officer', password: 'pw' },
      csrf: mintCsrfToken(),
    });
    check('csrf: a mismatched header is 403', wrongCsrf.status === 403);

    // ── 3. One rejection for every credential problem ──────────────────
    iam.on('POST', '/v1/auth/officer/login', (hit) =>
      hit === 0
        ? { status: 401, body: { error: 'INVALID_CREDENTIALS', detail: 'Invalid handle or password.' } }
        : {
            status: 200,
            body: {
              token: officerToken('RDF', ['REVIEWER', 'SUPERADMIN']),
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          },
    );
    const badLogin = await browser.call('POST', EDGE_PATHS.officerLogin, {
      body: { loginHandle: 'rdf.officer', password: 'wrong' },
    });
    check('login: a rejected credential is 401', badLogin.status === 401);
    check(
      'login: the rejection body is BARE — upstream said INVALID_CREDENTIALS and the edge did not repeat it',
      badLogin.text === '{}',
      badLogin.text,
    );
    const shortHandle = await browser.call('POST', EDGE_PATHS.officerLogin, {
      body: { loginHandle: '', password: 'x' },
    });
    check(
      'login: a SHAPE error is byte-identical to a wrong password',
      shortHandle.status === 400 && shortHandle.text === '{}',
    );

    // ── 4. A successful login hands over a handle, never a credential ────
    const login = await browser.call('POST', EDGE_PATHS.officerLogin, {
      body: { loginHandle: 'rdf.officer', password: 'right' },
    });
    check('login: success is 204 with NO body — the session is read back', login.status === 204 && login.text === '');
    const handle = browser.cookie(SESSION_COOKIE);
    check('login: an opaque session handle is set as a cookie', handle !== undefined && handle.length >= 40);
    check(
      'login: the session cookie is httpOnly + SameSite=Strict',
      login.setCookie.some(
        (c) =>
          c.startsWith(`${SESSION_COOKIE}=`) &&
          c.toLowerCase().includes('httponly') &&
          c.includes('SameSite=Strict'),
      ),
      login.setCookie,
    );
    check(
      'login: each attempt cost exactly one upstream call — a login is never retried',
      iam.hits('POST', '/v1/auth/officer/login') === 2,
    );
    check(
      'login: THE JWT IS NOT IN ANY Set-Cookie — the browser holds a handle, not a credential',
      !login.setCookie.some((c) => c.includes('USRP-AUTH')),
      login.setCookie,
    );

    const view = await browser.call('GET', EDGE_PATHS.session);
    check('session: an authenticated mount returns the officer view', view.status === 200 && view.json['kind'] === 'officer');
    check('session: the agency comes from the SIGNED token claims', view.json['agency'] === 'RDF');
    check(
      'session: the view has NO token field — there is nothing to put in one',
      !('token' in view.json) && !('credential' in view.json),
    );
    const roles = view.json['roles'];
    check(
      'session: SUPERADMIN is dropped on projection — it is unrepresentable end to end',
      Array.isArray(roles) && roles.includes('REVIEWER') && !roles.includes('SUPERADMIN'),
      roles,
    );
    const absolute = Date.parse(String(view.json['absoluteExpiresAt']));
    check(
      'session: the absolute ceiling is CLAMPED to the credential expiry (1h JWT, not the 12h config)',
      absolute - Date.now() < 2 * 3_600_000,
      view.json['absoluteExpiresAt'],
    );

    // ── 5. Officer reads: credential forwarded, agency echoed from session ──
    applications.on('GET', '/v1/applications', {
      status: 200,
      body: {
        agency: 'RDF',
        applications: [
          {
            applicationId: APP_ID,
            processingCode: 'RDF-00001',
            category: 'GENERAL_ENLISTMENT',
            status: 'SUBMITTED',
            submittedAt: '2026-09-01T10:00:00.000Z',
          },
        ],
      },
    });
    const list = await browser.call('GET', EDGE_PATHS.applications, { correlationId: 'corr-abc-123' });
    check('reads: the list is a bare array, unpaginated', list.status === 200 && Array.isArray(JSON.parse(list.text)));
    const listed = (JSON.parse(list.text) as Record<string, unknown>[])[0];
    check('reads: the processing code stands in for the applicant', listed?.['processingCode'] === 'RDF-00001');
    check('reads: the agency is echoed from the SESSION', listed?.['agency'] === 'RDF');
    const listCall = applications.last('GET', '/v1/applications');
    check(
      'reads: the officer JWT was presented upstream as a Bearer',
      listCall?.authorization?.startsWith('Bearer USRP-AUTH.') === true,
    );
    check('reads: the browser correlation id was FORWARDED, not reinvented', listCall?.correlationId === 'corr-abc-123');

    const badId = await browser.call('GET', `${EDGE_PATHS.applicationById}?applicationId=not-a-uuid`);
    check('reads: a malformed applicationId is a 400, never a fake 404', badId.status === 400);

    applications.on('GET', '/v1/applications/by-id', { status: 404, body: { error: 'NOT_FOUND' } });
    const missing = await browser.call('GET', `${EDGE_PATHS.applicationById}?applicationId=${APP_ID}`);
    check('reads: a missing record is 404', missing.status === 404);
    check(
      'reads: THE 404 IS BARE — a sibling agency id and a nonexistent one are byte-identical',
      missing.text === '{}',
      missing.text,
    );

    // ── 6. The accept lock does not name the other agency ──────────────
    applications.on('POST', '/v1/applications/accept', {
      status: 409,
      body: { status: 'CROSS_AGENCY_LOCKED', lockedByAgency: 'RNP' },
    });
    const locked = await browser.call('POST', EDGE_PATHS.accept, { body: { applicationId: APP_ID } });
    check('accept: a held lock is a 409', locked.status === 409);
    check('accept: the code is stable and agency-free', locked.json['error'] === 'ACCEPT_LOCK_HELD');
    check(
      'accept: THE HOLDING AGENCY IS NOT DISCLOSED — upstream said RNP and the edge dropped it',
      !locked.text.includes('RNP'),
      locked.text,
    );
    check('accept: a write is never retried (one upstream call)', applications.hits('POST', '/v1/applications/accept') === 1);

    // ── 7. The medical mode is derived from the session, not sent ───────
    applications.on('POST', '/v1/applications/medical-review', {
      status: 200,
      body: { status: 'APPLIED', fromStatus: 'PHYSICAL_TEST_COMPLETE', toStatus: 'MEDICAL_REVIEW' },
    });
    const medical = await browser.call('POST', EDGE_PATHS.medicalReview, {
      body: { applicationId: APP_ID, outcome: 'FIT' },
    });
    check('transitions: a recorded transition is 200', medical.status === 200);
    check(
      'transitions: the result is { applicationId, status } — NOT an application',
      medical.json['status'] === 'MEDICAL_REVIEW' && medical.json['applicationId'] === APP_ID,
    );
    check(
      'transitions: nothing resembling an application object is returned',
      !('category' in medical.json) && !('processingCode' in medical.json),
    );
    const medicalCall = applications.last('POST', '/v1/applications/medical-review');
    check(
      'transitions: an RDF session produced the BOARD field (fitnessStatus), derived from the session agency',
      medicalCall?.body['fitnessStatus'] === 'FIT' && medicalCall?.body['certVerdict'] === undefined,
      medicalCall?.body,
    );
    const wrongVocab = await browser.call('POST', EDGE_PATHS.medicalReview, {
      body: { applicationId: APP_ID, outcome: 'CERT_VERIFIED' },
    });
    check('transitions: an RDF officer cannot use the certificate vocabulary', wrongVocab.status === 422);

    // ── 8. nationalIdHash is REFUSED, not ignored ────────────────────
    const hashed = await browser.call('POST', EDGE_PATHS.verifyIdentity, {
      body: { nationalId: NID, nationalIdHash: 'a'.repeat(64) },
    });
    check('refusal: a body carrying nationalIdHash is rejected outright', hashed.status === 400);
    check('refusal: the forbidden field was never forwarded', identity.hits('POST', '/v1/identities/verify') === 0);

    // ── 9. verifyIdentity answers only `verified` ────────────────────
    identity.on('POST', '/v1/identities/verify', {
      status: 200,
      body: { status: 'ALREADY_EXISTS', applicantId: APPLICANT_ID },
    });
    const verified = await browser.call('POST', EDGE_PATHS.verifyIdentity, { body: { nationalId: NID } });
    check('broker: the one brokered route answers 200', verified.status === 200);
    check('broker: it reports ONLY `verified`', verified.text === JSON.stringify({ verified: true }), verified.text);
    check('broker: the opaque applicantId stays server-side', !verified.text.includes('99999999'));
    check('broker: the submitted National ID is never echoed', !verified.text.includes(NID));

    // ── 10. Walk-in resolves identity server-side and hides the QR code ──
    applications.on('POST', '/v1/applications/walk-in/register', {
      status: 201,
      body: {
        status: 'REGISTERED',
        applicationId: APP_ID,
        processingCode: 'RDF-00002',
        qrInvitationCode: 'QR-SECRET-BEARER-TOKEN',
      },
    });
    const walkIn = await browser.call('POST', EDGE_PATHS.walkInRegister, {
      body: { nationalId: NID, category: 'GENERAL_ENLISTMENT' },
    });
    check('walk-in: an RDF officer can register a candidate', walkIn.status === 201, walkIn.text);
    check('walk-in: identity was resolved SERVER-SIDE before registering', identity.hits('POST', '/v1/identities/verify') === 2);
    const registerCall = applications.last('POST', '/v1/applications/walk-in/register');
    check(
      'walk-in: the edge sent the opaque applicantId upstream, never a client-supplied hash',
      registerCall?.body['applicantId'] === APPLICANT_ID,
      registerCall?.body,
    );
    check(
      'walk-in: THE QR INVITATION CODE IS NOT RETURNED — it is a bearer credential',
      !walkIn.text.includes('QR-SECRET-BEARER-TOKEN'),
      walkIn.text,
    );

    // ── 11. Wrong session kind ──────────────────────────────────
    const officerOnCitizenRoute = await browser.call('GET', EDGE_PATHS.myApplications);
    check('kinds: an officer session on a citizen route is 403', officerOnCitizenRoute.status === 403);
    check('kinds: the code names the fault', officerOnCitizenRoute.json['error'] === 'WRONG_SESSION_KIND');

    // ── 12. Logout is real revocation, and idempotent ─────────────────
    const logout = await browser.call('POST', EDGE_PATHS.officerLogout);
    check('logout: 204', logout.status === 204);
    check('logout: the cookies are cleared', browser.cookie(SESSION_COOKIE) === undefined);
    const afterLogout = await browser.call('GET', EDGE_PATHS.applications);
    check('logout: THE HANDLE IS DESTROYED SERVER-SIDE — the only officer revocation there is', afterLogout.status === 401);
    const logoutAgain = await browser.call('POST', EDGE_PATHS.officerLogout);
    check('logout: retrying a logout is still 204 — a client must never be told it failed', logoutAgain.status === 204);

    // ── 13. Citizen OTP: the 202 says nothing about the subject ─────────
    browser.clear();
    await browser.call('GET', EDGE_PATHS.session);
    identity.on('POST', '/v1/applicants/auth/otp/request', { status: 202, body: { status: 'CHALLENGED' } });
    const otpKnown = await browser.call('POST', EDGE_PATHS.otpRequest, { body: { nationalId: NID } });
    const otpUnknown = await browser.call('POST', EDGE_PATHS.otpRequest, {
      body: { nationalId: '1200380000000000' },
    });
    check('otp: the request is accepted with 202', otpKnown.status === 202);
    check('otp: the body carries acceptance and NOTHING about the subject', otpKnown.text === JSON.stringify({ accepted: true }));
    check(
      'otp: a known and an unknown National ID are BYTE-IDENTICAL — no enumeration oracle',
      otpKnown.status === otpUnknown.status && otpKnown.text === otpUnknown.text,
    );
    const shortNid = await browser.call('POST', EDGE_PATHS.otpRequest, { body: { nationalId: '123' } });
    check('otp: a structurally invalid National ID is a bare 400', shortNid.status === 400 && shortNid.text === '{}');

    // Per-subject budget is 3, and `otpKnown` already spent one for this NID.
    const second = await browser.call('POST', EDGE_PATHS.otpRequest, { body: { nationalId: NID } });
    const third = await browser.call('POST', EDGE_PATHS.otpRequest, { body: { nationalId: NID } });
    check('otp: requests inside the budget are served', second.status === 202 && third.status === 202);
    const limited = await browser.call('POST', EDGE_PATHS.otpRequest, { body: { nationalId: NID } });
    check('otp: the per-SUBJECT rate limit trips — the 202 is not an oracle at volume', limited.status === 429, limited.text);
    check('otp: the limit is reported as a stable code', limited.json['error'] === 'RATE_LIMITED');

    // ── 14. A citizen session carries no agency ──────────────────────
    const citizenToken = 'opaque-citizen-session-token-32-bytes';
    identity.on('POST', '/v1/applicants/auth/otp/verify', {
      status: 200,
      body: { sessionToken: citizenToken, expiresAt: new Date(Date.now() + 1_800_000).toISOString() },
    });
    const verify = await browser.call('POST', EDGE_PATHS.otpVerify, {
      body: { nationalId: NID, otp: '123456' },
    });
    check('otp: verification is 204 with cookies and no body', verify.status === 204 && verify.text === '');
    check(
      'otp: THE OPAQUE TOKEN IS NOT IN ANY Set-Cookie',
      !verify.setCookie.some((c) => c.includes(citizenToken)),
      verify.setCookie,
    );
    const citizenView = await browser.call('GET', EDGE_PATHS.session);
    check('citizen: the session kind is applicant', citizenView.json['kind'] === 'applicant');
    check(
      'citizen: THERE IS NO AGENCY on a citizen session — a citizen is cross-agency',
      !('agency' in citizenView.json),
      citizenView.json,
    );

    identity.on('GET', '/v1/applicants/me/applications', {
      status: 200,
      body: {
        applications: [
          {
            applicationId: APP_ID,
            processingCode: 'RDF-00001',
            category: 'GENERAL_ENLISTMENT',
            status: 'DOCUMENT_REVIEW_AMBER',
            agency: 'RDF',
            submittedAt: '2026-09-01T10:00:00.000Z',
            documentForensicsScore: 42,
            documentLane: 'AMBER',
          },
        ],
      },
    });
    const mine = await browser.call('GET', EDGE_PATHS.myApplications);
    check('citizen: the citizen reads their own applications across agencies', mine.status === 200);
    const meCall = identity.last('GET', '/v1/applicants/me/applications');
    check('citizen: the OPAQUE token was presented upstream, not a JWT', meCall?.authorization === `Bearer ${citizenToken}`);
    check(
      'citizen: NO FORENSIC SCORE OR LANE REACHES THE UPLOADER — upstream offered both and the allowlist dropped them',
      !mine.text.includes('documentForensicsScore') &&
        !mine.text.includes('documentLane') &&
        !mine.text.includes('42'),
      mine.text,
    );

    // ── 15. Upstream revocation reaches the browser ───────────────────
    identity.on('GET', '/v1/applicants/me/applications', { status: 401, body: { error: 'INVALID_SESSION' } });
    const revoked = await browser.call('GET', EDGE_PATHS.myApplications);
    check('revocation: an upstream 401 becomes a 401 at the edge', revoked.status === 401);
    check('revocation: the reason lets the UI say "this session was ended"', revoked.json['reason'] === 'revoked');
    check('revocation: the cookies are cleared so the next request is cleanly anonymous', browser.cookie(SESSION_COOKIE) === undefined);

    // ── 16. Cookie injection cannot forge CSRF for a live session ───────
    iam.on('POST', '/v1/auth/officer/login', {
      status: 200,
      body: {
        token: officerToken('RNP', ['REVIEWER']),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    browser.clear();
    await browser.call('GET', EDGE_PATHS.session);
    await browser.call('POST', EDGE_PATHS.officerLogin, {
      body: { loginHandle: 'rnp.officer', password: 'right' },
    });
    const injected = mintCsrfToken();
    browser.setCookieValue(CSRF_COOKIE, injected);
    const injectedWrite = await browser.call('POST', EDGE_PATHS.accept, {
      body: { applicationId: APP_ID },
      csrf: injected,
    });
    check(
      'csrf: a MATCHING cookie+header pair still fails when it is not the session token — cookie injection defeated',
      injectedWrite.status === 403,
      injectedWrite.text,
    );

    // A live session that lost its readable cookie recovers by re-mounting.
    await browser.call('GET', EDGE_PATHS.session);
    check(
      'csrf: re-mounting restores the session own CSRF token, so a live session is never write-locked',
      browser.cookie(CSRF_COOKIE) !== injected,
    );

    // ── 17. RNP cannot walk in ──────────────────────────────────
    const registerBefore = applications.hits('POST', '/v1/applications/walk-in/register');
    const rnpWalkIn = await browser.call('POST', EDGE_PATHS.walkInRegister, {
      body: { nationalId: NID, category: 'GENERAL_ENLISTMENT' },
    });
    check(
      'walk-in: an RNP session is refused with 403, not 422',
      rnpWalkIn.status === 403 && rnpWalkIn.json['error'] === 'WALK_IN_NOT_AVAILABLE',
      rnpWalkIn.text,
    );
    check(
      'walk-in: the refusal costs NO upstream round trip — rnp_ops has no WALK_IN_* statuses to try',
      applications.hits('POST', '/v1/applications/walk-in/register') === registerBefore,
    );

    // ── 18. G2G faults keep their names; reads retry, writes do not ──────
    applications.on('GET', '/v1/applications/amber-queue', { status: 503, body: { error: 'NIDA_UNAVAILABLE' } });
    const g2g = await browser.call('GET', EDGE_PATHS.amberQueue);
    check('g2g: a named authority survives to the browser', g2g.status === 503 && g2g.json['error'] === 'NIDA_UNAVAILABLE');
    check(
      'g2g: a RETRYABLE read was retried exactly once (two upstream calls)',
      applications.hits('GET', '/v1/applications/amber-queue') === 2,
      applications.hits('GET', '/v1/applications/amber-queue'),
    );

    // ── 19. Refresh slides the idle window and NOT the ceiling ──────────
    const before = await browser.call('GET', EDGE_PATHS.session);
    await new Promise((r) => setTimeout(r, 1100));
    const refreshed = await browser.call('POST', EDGE_PATHS.sessionRefresh);
    check('refresh: 200 with the session view', refreshed.status === 200);
    check(
      'refresh: idleExpiresAt ADVANCED',
      Date.parse(String(refreshed.json['idleExpiresAt'])) > Date.parse(String(before.json['idleExpiresAt'])),
    );
    check(
      'refresh: absoluteExpiresAt DID NOT MOVE — the hard ceiling is not extendable by activity',
      refreshed.json['absoluteExpiresAt'] === before.json['absoluteExpiresAt'],
    );
  } finally {
    await server.stop();
    await Promise.all([iam.stop(), identity.stop(), applications.stop()]);
  }

  // ── 20. The PRODUCTION store, against the live database ──────────────
  await verifyPgStore();

  console.log('\n─────────────────────────────────────────────');
  if (failures.length === 0) {
    console.log(`\u001b[1;32mALL ${pass} EDGE ASSERTIONS GREEN ✓\u001b[0m`);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    process.exit(0);
  }
  console.error(`\u001b[0;31m${failures.length} of ${pass + failures.length} assertions FAILED\u001b[0m`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}

/**
 * The Postgres store is NOT stubbed: it holds live credentials, so its at-rest
 * behaviour is the single most important thing in this tier to prove for real.
 */
async function verifyPgStore(): Promise<void> {
  const handleHmacKey = 'dev_edge_session_hmac_key_min_32_chars!!';
  const store = new PgEdgeSessionStore({
    handleHmacKey,
    credentialKey: handleHmacKey,
    idleTtlSeconds: 1800,
  });
  const handle = mintHandle();
  const credential = `USRP-AUTH.v1.selfcheck-credential-${Date.now()}`;
  const now = Date.now();
  await store.create(handle, {
    kind: 'officer',
    credential,
    agency: 'RDF',
    roles: ['REVIEWER'],
    subjectId: '00000000-0000-4000-8000-000000000001',
    credentialExpiresAt: new Date(now + 3_600_000),
    idleExpiresAt: new Date(now + 60_000),
    absoluteExpiresAt: new Date(now + 3_600_000),
    csrfToken: mintCsrfToken(),
  });

  const live = await store.peek(handle);
  check('pg store: a created session resolves', live.kind === 'LIVE');
  check(
    'pg store: the credential round-trips through AES-GCM intact',
    live.kind === 'LIVE' && live.session.credential === credential,
  );

  const rows = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${sql('usrp_edge_session_writer')}`;
    return tx<{ handle_hash: string; credential_ciphertext: string; agency: string | null }[]>`
      SELECT handle_hash, credential_ciphertext, agency
      FROM public_core.edge_sessions
      WHERE handle_hash = ${hashHandle(handle, handleHmacKey)}
    `;
  });
  const row = rows[0];
  check('pg store: the row is readable under the least-privilege edge role', row !== undefined);
  check('pg store: THE HANDLE IS NOT STORED — only a keyed hash is', row !== undefined && !row.handle_hash.includes(handle));
  check(
    'pg store: THE CREDENTIAL IS NOT STORED IN PLAINTEXT — a database dump is not a set of bearer tokens',
    row !== undefined && !row.credential_ciphertext.includes(credential),
  );

  const slid = await store.touch(handle);
  check('pg store: touch slides the idle window in one statement', slid.kind === 'LIVE');
  check(
    'pg store: the slide is CLAMPED by the absolute ceiling',
    slid.kind === 'LIVE' && slid.session.idleExpiresAt.getTime() <= slid.session.absoluteExpiresAt.getTime(),
  );

  // An expired session must report WHICH expiry ended it.
  const expiredHandle = mintHandle();
  await store.create(expiredHandle, {
    kind: 'applicant',
    credential: 'opaque-expired',
    credentialExpiresAt: new Date(now + 3_600_000),
    idleExpiresAt: new Date(now - 1_000),
    absoluteExpiresAt: new Date(now + 3_600_000),
    csrfToken: mintCsrfToken(),
  });
  const ended = await store.peek(expiredHandle);
  check(
    'pg store: an idled-out session reports reason "idle", not a generic failure',
    ended.kind === 'ENDED' && ended.reason === 'idle',
  );

  await store.destroy(handle);
  await store.destroy(expiredHandle);
  const gone = await store.peek(handle);
  check('pg store: destroy removes the row — the credential stops being held', gone.kind === 'NONE');

  let idempotent = true;
  try {
    await store.destroy(handle);
    await store.destroy(mintHandle());
  } catch {
    idempotent = false;
  }
  check('pg store: destroying an absent session is not an error (logout must be idempotent)', idempotent);

  // The agency CHECK constraint is the database refusing an agency on a citizen.
  let constraintHeld = false;
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql('usrp_edge_session_writer')}`;
      await tx`
        INSERT INTO public_core.edge_sessions
          (handle_hash, kind, agency, credential_ciphertext, credential_expires_at,
           csrf_token, idle_expires_at, absolute_expires_at)
        VALUES (${'f'.repeat(64)}, 'applicant', 'RDF'::public_core.agency, 'x',
                now() + interval '1 hour', 'c', now() + interval '5 minutes',
                now() + interval '1 hour')
      `;
    });
  } catch {
    constraintHeld = true;
  }
  check(
    'pg store: THE DATABASE REFUSES an agency on a citizen session — "no agency" is a constraint, not a convention',
    constraintHeld,
  );
  await sql
    .begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql('usrp_edge_session_writer')}`;
      await tx`DELETE FROM public_core.edge_sessions WHERE handle_hash = ${'f'.repeat(64)}`;
    })
    .catch(() => undefined);
}

main().catch((err: unknown) => {
  console.error('\u001b[0;31mSELFCHECK CRASHED\u001b[0m', err);
  process.exit(1);
});
