// ══════════════════════════════════════════════════════════════════
// iam-service — Officer lifecycle LIVE proof (ADR-036, rls/0033)
//
// Real PostgreSQL (a disposable database bootstrapped from every migration and
// every rls/ file), real iam-service HTTP (login + officer-admin routes), real
// edge-gateway HTTP with its persistent session store. Nothing is stubbed.
//
// What it proves:
//   • create (never a code) → a DIFFERENT administrator releases the one-time code
//     once (stored only as a hash) → activate → login; creator, cross-agency and
//     replayed releases refused (ADR-036 addendum, four-eyes);
//     the code is single-use, a wrong code / weak password are refused;
//   • reissue replaces an unredeemed code, never resets an activated account;
//   • assign posts → the officer's ALREADY-OPEN edge session is refused on the
//     next request; a new login carries the new posts;
//   • disable → the officer's ALREADY-OPEN edge session is refused on the next
//     request; login is 401 (edge and IAM); enable restores login;
//   • revokeOfficerSessions ends an open session without touching the account;
//   • a disabled ADMINISTRATOR loses their open session, and their still-valid
//     one-hour bearer token is refused by iam-service (live DB re-check);
//   • cross-agency target = 404, list is agency-scoped;
//   • self-escalation refused (self posts, agency_admin never assignable);
//   • last active admin cannot be disabled; self-disable otherwise refused;
//   • reviewer denied at the edge and at the service; agency/officerId in a
//     body refused; usrp_iam_service cannot write accounts directly and agency
//     officer roles cannot execute the command functions;
//   • one PII-free AUDIT_ENTRY per command, in the outbox;
//   • no credential, code hash or password in any response or event.
//
//   DATABASE_URL (usrp_app) + ADMIN_DATABASE_URL (usrp_admin) — dev defaults.
//   npx tsx services/iam-service/selfcheck/verify-officer-lifecycle.ts
// ══════════════════════════════════════════════════════════════════

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { configureDatabase, sql } from '@usrp/shared-database';
import { InMemoryEventBus } from '@usrp/shared-events';
import { startHttpServer, type HttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair, hashPassword } from '@usrp/shared-security';
import { createIamService, loadIamConfig, officerAdminRoutes, officerLoginRoutes } from '../src/index.js';
import { createEdgeGateway, loadEdgeGatewayConfig } from '../../edge-gateway/src/index.js';

const BASE_APP_URL = process.env['DATABASE_URL'] ?? 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db';
const ADMIN_URL = process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/shared-database/src/migrations');
const RLS_DIR = resolve(REPO_ROOT, 'packages/shared-database/src/rls');

const runId = randomUUID().replaceAll('-', '').slice(0, 10).toLowerCase();
const databaseName = `usrp_s01_officers_${process.pid}_${runId}`;
const clusterAdmin = postgres(ADMIN_URL, { max: 1, prepare: false, onnotice: () => {} });

const RDF_ADMIN_A = randomUUID();
const RDF_ADMIN_B = randomUUID();
const RNP_ADMIN = randomUUID();
const RDF_REVIEWER = randomUUID();
const PW = {
  adminA: `AdminA-${randomUUID()}`,
  adminB: `AdminB-${randomUUID()}`,
  rnp: `AdminRnp-${randomUUID()}`,
  reviewer: `Reviewer-${randomUUID()}`,
  gate: `Gate-${randomUUID()}`,
  pending: `Pending-${randomUUID()}`,
};
const H = {
  adminA: `s01.rdf.admin.a.${runId}`,
  adminB: `s01.rdf.admin.b.${runId}`,
  rnp: `s01.rnp.admin.${runId}`,
  reviewer: `s01.rdf.reviewer.${runId}`,
  gate: `s01.rdf.gate.${runId}`,
  pending: `s01.rdf.pending.${runId}`,
};

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
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** Every response body this proof sees, for the final no-credential sweep. */
const seenBodies: string[] = [];

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function readReply(response: Response): Promise<Reply> {
  const text = await response.text();
  seenBodies.push(text);
  let body: Record<string, unknown> = {};
  if (text !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch {
      body = { raw: text };
    }
  }
  return { status: response.status, body };
}

/** A browser: a cookie jar against the edge, CSRF double-submit on POST. */
class Browser {
  readonly #cookies = new Map<string, string>();
  constructor(private readonly base: string, private readonly csrfCookie: string) {}

  #absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (pair === undefined || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(header)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#cookies.size > 0) headers['cookie'] = [...this.#cookies].map(([n, v]) => `${n}=${v}`).join('; ');
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      const csrf = this.#cookies.get(this.csrfCookie);
      if (csrf !== undefined) headers['x-csrf-token'] = csrf;
    }
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.#absorb(response);
    return readReply(response);
  }

  get(path: string): Promise<Reply> {
    return this.send('GET', path);
  }
  post(path: string, body: unknown = {}): Promise<Reply> {
    return this.send('POST', path, body);
  }

  /** Seed CSRF, then log in. Returns the login status (204 on success). */
  async login(loginHandle: string, password: string): Promise<number> {
    await this.get('/edge/v1/session');
    return (await this.post('/edge/v1/auth/officer/login', { loginHandle, password })).status;
  }
}

async function bootstrap(database: ReturnType<typeof postgres>): Promise<void> {
  for (const dir of [MIGRATIONS_DIR, RLS_DIR]) {
    const files = readdirSync(dir).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort();
    for (const file of files) await database.unsafe(readFileSync(resolve(dir, file), 'utf8'));
  }
}

/** Run `query` as `role` and report the SQLSTATE it fails with ('ok' when it succeeds). */
async function sqlstateAs(role: string, query: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<string> {
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql(role)}`;
      await query(tx);
    });
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'error';
  }
}

async function main(): Promise<void> {
  let iamServer: HttpServer | undefined;
  let edgeServer: HttpServer | undefined;
  let proof: ReturnType<typeof postgres> | undefined;
  let created = false;
  let sharedConfigured = false;
  const bus = new InMemoryEventBus();

  try {
    await clusterAdmin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const proofAdminUrl = new URL(ADMIN_URL);
    proofAdminUrl.pathname = `/${databaseName}`;
    proof = postgres(proofAdminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const db = proof;
    await bootstrap(db);
    // rls/0033 must be replay-safe: apply it a second time on the populated schema.
    await db.unsafe(readFileSync(resolve(RLS_DIR, '0033_officer_lifecycle.sql'), 'utf8'));

    const appUrl = new URL(BASE_APP_URL);
    appUrl.pathname = `/${databaseName}`;
    process.env['DATABASE_URL'] = appUrl.toString();
    configureDatabase({ url: appUrl.toString(), maxConnections: 10 });
    sharedConfigured = true;
    console.log(`Officer lifecycle — real IAM + Edge + PostgreSQL against disposable ${databaseName}`);

    // ── Fixtures through the operator paths (first-admin function + direct insert) ──
    for (const [id, handle, password, agency] of [
      [RDF_ADMIN_A, H.adminA, PW.adminA, 'RDF'],
      [RNP_ADMIN, H.rnp, PW.rnp, 'RNP'],
    ] as const) {
      await db.begin(async (tx) => {
        await tx`SET LOCAL SESSION AUTHORIZATION usrp_iam_provisioner`;
        await tx`SELECT public_core.provision_first_campaign_agency_admin(
          ${id}::uuid, ${handle}, ${hashPassword(password)}, ${agency}::public_core.agency,
          ${`S01-SELFCHECK-${runId}`}, ${`S01-${runId}`})`;
      });
    }
    // A second RDF administrator and a reviewer, as an operator would (direct, privileged).
    await db`
      INSERT INTO public_core.officer_accounts (officer_id, login_handle, credential, agency, roles, status)
      VALUES (${RDF_ADMIN_B}::uuid, ${H.adminB}, ${hashPassword(PW.adminB)}, 'RDF', ARRAY['agency_admin']::text[], 'active'),
             (${RDF_REVIEWER}::uuid, ${H.reviewer}, ${hashPassword(PW.reviewer)}, 'RDF', ARRAY['reviewer']::text[], 'active')`;

    section('Database boundary');
    const iamWrite = await sqlstateAs('usrp_iam_service', (tx) =>
      tx`UPDATE public_core.officer_accounts SET status = 'disabled' WHERE officer_id = ${RDF_REVIEWER}::uuid`);
    check('usrp_iam_service still cannot UPDATE officer_accounts directly (42501)', iamWrite === '42501', iamWrite);
    const officerExec = await sqlstateAs('usrp_rdf_officer', (tx) =>
      tx`SELECT public_core.officer_list(${RDF_ADMIN_A}::uuid, 'RDF')`);
    check('an agency officer role cannot EXECUTE the officer command functions (42501)', officerExec === '42501', officerExec);
    const unbound = await sqlstateAs('usrp_iam_service', (tx) =>
      tx`SELECT public_core.officer_list(${RDF_ADMIN_A}::uuid, 'RDF')`);
    check('a command without the transaction-bound actor is refused (42501)', unbound === '42501', unbound);
    const substituted = await sqlstateAs('usrp_iam_service', async (tx) => {
      await tx`SELECT set_config('usrp.officer_actor_id', ${RDF_REVIEWER}, true)`;
      await tx`SELECT public_core.officer_list(${RDF_REVIEWER}::uuid, 'RDF')`;
    });
    check('a bound actor who is not an active agency_admin is refused (42501)', substituted === '42501', substituted);
    const codeGrants = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
      WHERE table_schema = 'public_core' AND table_name = 'officer_activation_codes'
        AND grantee IN ('usrp_app', 'usrp_iam_service', 'usrp_system_service', 'usrp_edge_gateway',
                        'usrp_rdf_officer', 'usrp_rnp_officer', 'usrp_rcs_officer', 'PUBLIC')`;
    check('no login or service role holds any privilege on the activation-code store', codeGrants[0]?.n === 0);

    // ── Real services ──
    const keys = generateDeviceKeyPair();
    const privateB64 = Buffer.from(keys.privateKeyPem, 'utf8').toString('base64');
    const publicB64 = Buffer.from(keys.publicKeyPem, 'utf8').toString('base64');
    const iam = createIamService(
      loadIamConfig({ ...process.env, DATABASE_URL: appUrl.toString(), AUTH_JWT_PRIVATE_KEY_B64: privateB64, JWT_ISSUER: 'usrp', JWT_AUDIENCE: 'usrp-services' }),
      bus,
    );
    await bus.connect();
    iamServer = await startHttpServer({
      serviceName: 'iam-s01-officer-lifecycle',
      port: 0,
      host: '127.0.0.1',
      routes: [...officerLoginRoutes(iam.login), ...officerAdminRoutes(iam.officerAdmin, iam.verifier)],
      handleSignals: false,
      logger: () => {},
    });
    const edgeConfig = loadEdgeGatewayConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: appUrl.toString(),
      EDGE_SESSION_HMAC_KEY: randomBytes(32).toString('hex'),
      EDGE_SESSION_IDLE_TTL_SECONDS: '600',
      EDGE_SESSION_ABSOLUTE_TTL_SECONDS: '1800',
      EDGE_COOKIE_SECURE: 'false',
      CORS_ORIGINS: 'https://s01.example.test',
      IAM_BASE_URL: iamServer.url,
      IDENTITY_SERVICE_BASE_URL: 'http://127.0.0.1:1',
      APPLICATION_SERVICE_BASE_URL: 'http://127.0.0.1:1',
      SCHEDULING_SERVICE_BASE_URL: 'http://127.0.0.1:1',
      FIELD_SYNC_SERVICE_BASE_URL: 'http://127.0.0.1:1',
      AUTH_JWT_PUBLIC_KEY_B64: publicB64,
      JWT_ISSUER: 'usrp',
      JWT_AUDIENCE: 'usrp-services',
      EDGE_LOGIN_RATE_LIMIT_PER_MINUTE: '200',
    });
    const edge = createEdgeGateway(edgeConfig);
    edgeServer = await startHttpServer({
      serviceName: 'edge-s01-officer-lifecycle',
      port: 0,
      host: '127.0.0.1',
      routes: edge.routes,
      cors: edge.cors,
      handleSignals: false,
      logger: () => {},
    });
    const edgeUrl = edgeServer.url;
    const iamUrl = iamServer.url;
    const browser = (): Browser => new Browser(edgeUrl, edge.deps.cookies.csrfCookieName);
    const iamLogin = async (loginHandle: string, password: string): Promise<Reply> =>
      readReply(await fetch(`${iamUrl}/v1/auth/officer/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loginHandle, password }),
      }));
    const iamAs = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> =>
      readReply(await fetch(`${iamUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));

    section('List — agency-scoped, credential-free');
    const adminA = browser();
    check('RDF administrator signs in through the edge', (await adminA.login(H.adminA, PW.adminA)) === 204);
    const listed = await adminA.get('/edge/v1/officers');
    const listedOfficers = (listed.body['officers'] ?? []) as Record<string, unknown>[];
    const handles = listedOfficers.map((o) => o['loginHandle']);
    check('listOfficers answers 200 with the RDF officers', listed.status === 200 && handles.includes(H.adminA) && handles.includes(H.reviewer));
    check('the list never includes another agency\'s officer', !handles.includes(H.rnp));
    check('every listed row carries exactly the allowlisted fields',
      listedOfficers.every((o) => Object.keys(o).sort().join() === 'activatedAt,activationExpiresAt,activationState,createdAt,lastLoginAt,loginHandle,officerId,posts,releasableByYou,status'));
    const adminRow = listedOfficers.find((o) => o['loginHandle'] === H.adminA);
    check('the administrator\'s own last login is stamped', typeof adminRow?.['lastLoginAt'] === 'string');
    check('operator-provisioned accounts count as activated', typeof adminRow?.['activatedAt'] === 'string');

    section('Create → (no code) → second-admin release → activate → login');
    const forbiddenAgency = await adminA.post('/edge/v1/officers', { loginHandle: H.gate, posts: ['screening_officer'], agency: 'RNP' });
    check('a body naming an agency is refused at the edge (FORBIDDEN_FIELD)', forbiddenAgency.status === 400 && forbiddenAgency.body['error'] === 'FORBIDDEN_FIELD');
    const adminPost = await adminA.post('/edge/v1/officers', { loginHandle: `${H.gate}x`, posts: ['agency_admin'] });
    check('agency_admin cannot be granted at creation (403 AGENCY_ADMIN_NOT_ASSIGNABLE)', adminPost.status === 403 && adminPost.body['error'] === 'AGENCY_ADMIN_NOT_ASSIGNABLE');
    const unknownPost = await adminA.post('/edge/v1/officers', { loginHandle: `${H.gate}y`, posts: ['superadmin'] });
    check('an unknown post is refused (422 UNKNOWN_POST)', unknownPost.status === 422 && unknownPost.body['error'] === 'UNKNOWN_POST');

    const createdGate = await adminA.post('/edge/v1/officers', { loginHandle: H.gate, posts: ['screening_officer'] });
    const gateOfficer = createdGate.body['officer'] as Record<string, unknown> | undefined;
    const gateId = String(gateOfficer?.['officerId'] ?? '');
    check('createOfficer answers 201 with a pending officer awaiting release and NO code',
      createdGate.status === 201 && gateOfficer?.['status'] === 'pending' && gateOfficer['activationState'] === 'PENDING_RELEASE' &&
      Object.keys(createdGate.body).sort().join() === 'officer,outcome' && !/[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}/.test(JSON.stringify(createdGate.body)));
    const dup = await adminA.post('/edge/v1/officers', { loginHandle: H.gate, posts: ['reviewer'] });
    check('a taken handle is refused (409 HANDLE_TAKEN)', dup.status === 409 && dup.body['error'] === 'HANDLE_TAKEN');

    const beforeRelease = await db<{ code_hash: string | null; released_at: Date | null; created_by: string; issued_by: string }[]>`
      SELECT code_hash, released_at, created_by, issued_by FROM public_core.officer_activation_codes WHERE officer_id = ${gateId}::uuid`;
    check('before release no code exists anywhere: the hash is NULL, nothing is released',
      beforeRelease.length === 1 && beforeRelease[0]?.code_hash === null && beforeRelease[0].released_at === null &&
      beforeRelease[0].created_by === RDF_ADMIN_A && beforeRelease[0].issued_by === RDF_ADMIN_A);

    section('FOUR-EYES release (ADR-036 addendum)');
    const adminB = browser();
    check('a second RDF administrator signs in', (await adminB.login(H.adminB, PW.adminB)) === 204);
    const rnp = browser();
    check('the RNP administrator signs in', (await rnp.login(H.rnp, PW.rnp)) === 204);
    const rowOf = async (b: Browser, id: string): Promise<Record<string, unknown> | undefined> =>
      (((await b.get('/edge/v1/officers')).body['officers'] ?? []) as Record<string, unknown>[]).find((o) => o['officerId'] === id);
    check('the creating administrator is NOT offered the release', (await rowOf(adminA, gateId))?.['releasableByYou'] === false);
    check('the second administrator IS offered the release', (await rowOf(adminB, gateId))?.['releasableByYou'] === true);
    const earlyAnon = browser();
    await earlyAnon.get('/edge/v1/session');
    const beforeActivate = await earlyAnon.post('/edge/v1/auth/officer/activate', { loginHandle: H.gate, activationCode: 'AAAAA-AAAAA-AAAAA-AAAAA', password: PW.gate });
    check('an unreleased account cannot be activated (401 ACTIVATION_REJECTED)', beforeActivate.status === 401);

    const creatorRelease = await adminA.post('/edge/v1/officers/activation/release', { targetOfficerId: gateId });
    check('the CREATING administrator is refused (403 SAME_ADMIN) and receives no code',
      creatorRelease.status === 403 && creatorRelease.body['error'] === 'SAME_ADMIN' && Object.keys(creatorRelease.body).join() === 'error');
    const crossRelease = await rnp.post('/edge/v1/officers/activation/release', { targetOfficerId: gateId });
    const crossGhost = await rnp.post('/edge/v1/officers/activation/release', { targetOfficerId: randomUUID() });
    check('an administrator of ANOTHER agency is refused (404 NOT_FOUND, identical to a nonexistent officer)',
      crossRelease.status === 404 && crossRelease.body['error'] === 'NOT_FOUND' && JSON.stringify(crossRelease.body) === JSON.stringify(crossGhost.body));
    const stillNull = await db<{ code_hash: string | null }[]>`SELECT code_hash FROM public_core.officer_activation_codes WHERE officer_id = ${gateId}::uuid`;
    check('the refused attempts released nothing', stillNull[0]?.code_hash === null);

    const directToken = String((await iamLogin(H.adminA, PW.adminA)).body['token'] ?? '');
    const directCreate = await iamAs(directToken, 'POST', '/v1/officers', { loginHandle: `s06.direct.${runId}`, posts: ['reviewer'] });
    check('at the IDENTITY-SERVICE route too, create answers 201 with no activation, no code and no hash',
      directCreate.status === 201 && Object.keys(directCreate.body).sort().join() === 'officer,outcome' &&
      !/[A-Z2-9]{5}-[A-Z2-9]{5}|"code"|activation"|hash/i.test(JSON.stringify(directCreate.body)));
    const directId = String((directCreate.body['officer'] as Record<string, unknown> | undefined)?.['officerId'] ?? '');
    const directReissue = await iamAs(directToken, 'POST', '/v1/officers/activation/reissue', { targetOfficerId: directId });
    check('…and reissue answers 200 with no code', directReissue.status === 200 && Object.keys(directReissue.body).sort().join() === 'officer,outcome');
    const directSame = await iamAs(directToken, 'POST', '/v1/officers/activation/release', { targetOfficerId: directId });
    check('…and the identity service itself refuses the creator (403 SAME_ADMIN)', directSame.status === 403 && directSame.body['error'] === 'SAME_ADMIN');

    const released = await adminB.post('/edge/v1/officers/activation/release', { targetOfficerId: gateId });
    const activation = released.body['activation'] as Record<string, unknown> | undefined;
    const code = String(activation?.['code'] ?? '');
    const compactCode = code.replaceAll('-', '');
    check('a DIFFERENT administrator of the same agency releases the code once (200 RELEASED)',
      released.status === 200 && released.body['outcome'] === 'RELEASED' && /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(code) &&
      (released.body['officer'] as Record<string, unknown> | undefined)?.['activationState'] === 'RELEASED');
    const replayRelease = await adminB.post('/edge/v1/officers/activation/release', { targetOfficerId: gateId });
    check('a replay is refused (409 ALREADY_RELEASED) and carries no code',
      replayRelease.status === 409 && replayRelease.body['error'] === 'ALREADY_RELEASED' && Object.keys(replayRelease.body).join() === 'error');
    const creatorAgain = await adminA.post('/edge/v1/officers/activation/release', { targetOfficerId: gateId });
    check('the creator is still refused after the release (403 SAME_ADMIN)', creatorAgain.status === 403 && creatorAgain.body['error'] === 'SAME_ADMIN');
    check('the list no longer offers a release', (await rowOf(adminB, gateId))?.['releasableByYou'] === false);

    const stored = await db<{ code_hash: string; expires_at: Date; released_at: Date; released_by: string }[]>`
      SELECT code_hash, expires_at, released_at, released_by FROM public_core.officer_activation_codes WHERE officer_id = ${gateId}::uuid`;
    const plaintextAnywhere = await db<{ n: string }[]>`
      SELECT (SELECT count(*) FROM public_core.officer_activation_codes WHERE code_hash LIKE ${'%' + compactCode + '%'})
           + (SELECT count(*) FROM public_core.officer_accounts WHERE credential LIKE ${'%' + compactCode + '%'})
           + (SELECT count(*) FROM public_core.event_outbox WHERE payload::text LIKE ${'%' + compactCode + '%'}) AS n`;
    check('only a 64-hex hash of the code is stored; the code appears nowhere in the database',
      stored.length === 1 && /^[0-9a-f]{64}$/.test(stored[0]?.code_hash ?? '') && Number(plaintextAnywhere[0]?.n) === 0 && stored[0]?.released_by === RDF_ADMIN_B,
      `rows=${String(stored.length)} matches=${String(plaintextAnywhere[0]?.n)}`);
    const ttlHours = stored[0] ? (stored[0].expires_at.getTime() - stored[0].released_at.getTime()) / 3_600_000 : 0;
    check('the code expires 24 hours after RELEASE', Math.abs(ttlHours - 24) < 0.001, String(ttlHours));

    const gate = browser();
    check('a pending officer cannot log in before activation', (await gate.login(H.gate, PW.gate)) === 401);
    const anon = browser();
    await anon.get('/edge/v1/session');
    const wrongCode = await anon.post('/edge/v1/auth/officer/activate', { loginHandle: H.gate, activationCode: 'AAAAA-AAAAA-AAAAA-AAAAA', password: PW.gate });
    check('a wrong code is refused (401 ACTIVATION_REJECTED)', wrongCode.status === 401 && wrongCode.body['error'] === 'ACTIVATION_REJECTED');
    const unknownHandle = await anon.post('/edge/v1/auth/officer/activate', { loginHandle: `nobody.${runId}`, activationCode: code, password: PW.gate });
    check('an unknown handle gets the identical answer (no enumeration)', unknownHandle.status === 401 && JSON.stringify(unknownHandle.body) === JSON.stringify(wrongCode.body));
    const weak = await anon.post('/edge/v1/auth/officer/activate', { loginHandle: H.gate, activationCode: code, password: 'short' });
    check('a too-short password is refused (400 WEAK_PASSWORD)', weak.status === 400 && weak.body['error'] === 'WEAK_PASSWORD');
    await db`UPDATE public_core.officer_activation_codes SET expires_at = now() - interval '1 second' WHERE officer_id = ${gateId}::uuid`;
    const expired = await anon.post('/edge/v1/auth/officer/activate', { loginHandle: H.gate, activationCode: code, password: PW.gate });
    check('an expired code is refused (401 ACTIVATION_REJECTED)', expired.status === 401);
    await db`UPDATE public_core.officer_activation_codes SET expires_at = released_at + interval '24 hours' WHERE officer_id = ${gateId}::uuid`;
    const activated = await anon.post('/edge/v1/auth/officer/activate', { loginHandle: H.gate, activationCode: code.toLowerCase(), password: PW.gate });
    check('the right code activates the account (204)', activated.status === 204);
    const replayed = await anon.post('/edge/v1/auth/officer/activate', { loginHandle: H.gate, activationCode: code, password: `${PW.gate}-again` });
    check('the code is single-use (a replay is ACTIVATION_REJECTED)', replayed.status === 401);
    check('the activated officer logs in at the edge', (await gate.login(H.gate, PW.gate)) === 204);
    const gateSession = await gate.get('/edge/v1/session');
    check('the session carries exactly the assigned post', JSON.stringify(gateSession.body['roles']) === JSON.stringify(['screening_officer']));
    const credentialRow = await db<{ credential: string; status: string; activated: boolean }[]>`
      SELECT credential, status, activated_at IS NOT NULL AS activated FROM public_core.officer_accounts WHERE officer_id = ${gateId}::uuid`;
    check('the stored credential is the officer\'s own scrypt digest; status active; activated_at set',
      credentialRow[0]?.credential.startsWith('scrypt$') === true && credentialRow[0]?.status === 'active' && credentialRow[0]?.activated === true);

    section('Reissue — only for a never-activated account; never carries a code');
    const createdPending = await adminA.post('/edge/v1/officers', { loginHandle: H.pending, posts: ['medical_officer'] });
    const pendingId = String((createdPending.body['officer'] as Record<string, unknown> | undefined)?.['officerId'] ?? '');
    const firstRelease = await adminB.post('/edge/v1/officers/activation/release', { targetOfficerId: pendingId });
    const firstCode = String((firstRelease.body['activation'] as Record<string, unknown> | undefined)?.['code'] ?? '');
    check('a second officer is created and released', firstRelease.status === 200 && firstCode !== '');
    const reissued = await adminA.post('/edge/v1/officers/activation/reissue', { targetOfficerId: pendingId });
    check('reissue answers 200 with NO code', reissued.status === 200 && reissued.body['outcome'] === 'REISSUED' &&
      Object.keys(reissued.body).sort().join() === 'officer,outcome' && (reissued.body['officer'] as Record<string, unknown> | undefined)?.['activationState'] === 'PENDING_RELEASE');
    const oldCode = await anon.post('/edge/v1/auth/officer/activate', { loginHandle: H.pending, activationCode: firstCode, password: PW.pending });
    check('the previously released code no longer activates', oldCode.status === 401);
    const reissuerSelf = await adminA.post('/edge/v1/officers/activation/release', { targetOfficerId: pendingId });
    check('the reissuing administrator cannot release it (403 SAME_ADMIN)', reissuerSelf.status === 403 && reissuerSelf.body['error'] === 'SAME_ADMIN');
    const reissuedByB = await adminB.post('/edge/v1/officers/activation/reissue', { targetOfficerId: pendingId });
    check('another administrator reissues', reissuedByB.status === 200);
    const bothRefused = await Promise.all([adminA, adminB].map((b) => b.post('/edge/v1/officers/activation/release', { targetOfficerId: pendingId })));
    check('after that, neither the creator nor the latest reissuer may release (403 SAME_ADMIN)',
      bothRefused.every((r) => r.status === 403 && r.body['error'] === 'SAME_ADMIN'));
    await adminA.post('/edge/v1/officers/activation/reissue', { targetOfficerId: pendingId });
    const secondRelease = await adminB.post('/edge/v1/officers/activation/release', { targetOfficerId: pendingId });
    const secondCode = String((secondRelease.body['activation'] as Record<string, unknown> | undefined)?.['code'] ?? '');
    check('the next release yields a different code', secondRelease.status === 200 && secondCode !== '' && secondCode !== firstCode);
    const newCode = await anon.post('/edge/v1/auth/officer/activate', { loginHandle: H.pending, activationCode: secondCode, password: PW.pending });
    check('the released code activates', newCode.status === 204);
    const notPending = await adminA.post('/edge/v1/officers/activation/reissue', { targetOfficerId: gateId });
    check('reissue on an activated account is refused (409 NOT_PENDING_ACTIVATION) — never a password reset',
      notPending.status === 409 && notPending.body['error'] === 'NOT_PENDING_ACTIVATION');
    const releaseActivated = await adminB.post('/edge/v1/officers/activation/release', { targetOfficerId: gateId });
    check('release on an activated account is refused (409 NOT_PENDING_ACTIVATION)', releaseActivated.status === 409 && releaseActivated.body['error'] === 'NOT_PENDING_ACTIVATION');

    section('Assign posts — the open session ends; a new login carries the new posts');
    const forbiddenOfficerId = await adminA.post('/edge/v1/officers/posts', { officerId: gateId, posts: ['reviewer'], reasonCode: 'CORRECTION' });
    check('`officerId` (an actor field) is refused in a body at the edge', forbiddenOfficerId.status === 400 && forbiddenOfficerId.body['error'] === 'FORBIDDEN_FIELD');
    const grantAdmin = await adminA.post('/edge/v1/officers/posts', { targetOfficerId: gateId, posts: ['agency_admin'], reasonCode: 'CORRECTION' });
    check('agency_admin is never assignable (403)', grantAdmin.status === 403 && grantAdmin.body['error'] === 'AGENCY_ADMIN_NOT_ASSIGNABLE');
    const assigned = await adminA.post('/edge/v1/officers/posts', { targetOfficerId: gateId, posts: ['screening_officer', 'decision_authority'], reasonCode: 'POSTING_CHANGE' });
    check('assignOfficerPosts answers ASSIGNED and revoked the open session',
      assigned.status === 200 && assigned.body['outcome'] === 'ASSIGNED' && assigned.body['sessionsRevoked'] === 1);
    const afterAssign = await gate.get('/edge/v1/session');
    check('the officer\'s ALREADY-OPEN session is refused on its next request (401 revoked)',
      afterAssign.status === 401 && afterAssign.body['reason'] === 'revoked');
    check('the officer signs in again', (await gate.login(H.gate, PW.gate)) === 204);
    const newRoles = await gate.get('/edge/v1/session');
    check('the new session carries the new posts', JSON.stringify(newRoles.body['roles']) === JSON.stringify(['decision_authority', 'screening_officer']));
    const unchanged = await adminA.post('/edge/v1/officers/posts', { targetOfficerId: gateId, posts: ['decision_authority', 'screening_officer'], reasonCode: 'CORRECTION' });
    check('the same post set is UNCHANGED and revokes nothing', unchanged.body['outcome'] === 'UNCHANGED' && unchanged.body['sessionsRevoked'] === 0);
    check('…and the officer\'s session survives it', (await gate.get('/edge/v1/session')).status === 200);

    section('Disable — an ALREADY-OPEN browser session is refused on the next request');
    const before = await gate.get('/edge/v1/session');
    check('precondition: the officer\'s browser session is open and working', before.status === 200);
    const disabled = await adminA.post('/edge/v1/officers/disable', { targetOfficerId: gateId, reasonCode: 'SUSPENDED' });
    check('disableOfficer answers DISABLED and revoked the open session',
      disabled.status === 200 && disabled.body['outcome'] === 'DISABLED' && disabled.body['sessionsRevoked'] === 1);
    const afterDisable = await gate.get('/edge/v1/session');
    check('PROOF: the disabled officer\'s already-open session is refused on the very next request (401 revoked)',
      afterDisable.status === 401 && afterDisable.body['reason'] === 'revoked');
    const revokedRow = await db<{ revoked_reason: string; blank: boolean }[]>`
      SELECT revoked_reason, upstream_credential = '' AS blank FROM public_core.edge_sessions
      WHERE subject_id = ${gateId}::uuid ORDER BY issued_at DESC LIMIT 1`;
    check('the session row records ACCOUNT_DISABLED and its sealed credential is blanked',
      revokedRow[0]?.revoked_reason === 'ACCOUNT_DISABLED' && revokedRow[0]?.blank === true);
    check('a disabled officer cannot log in at the edge', (await browser().login(H.gate, PW.gate)) === 401);
    check('…nor directly at IAM (401 INVALID_CREDENTIALS)', (await iamLogin(H.gate, PW.gate)).status === 401);
    const disableAgain = await adminA.post('/edge/v1/officers/disable', { targetOfficerId: gateId, reasonCode: 'SUSPENDED' });
    check('disabling again is UNCHANGED', disableAgain.body['outcome'] === 'UNCHANGED');
    const badReason = await adminA.post('/edge/v1/officers/enable', { targetOfficerId: gateId, reasonCode: 'SUSPENDED' });
    check('a reason from another command is refused (422 INVALID_REASON)', badReason.status === 422 && badReason.body['error'] === 'INVALID_REASON');
    const enabled = await adminA.post('/edge/v1/officers/enable', { targetOfficerId: gateId, reasonCode: 'SUSPENSION_LIFTED' });
    check('enableOfficer answers ENABLED with status active', enabled.body['outcome'] === 'ENABLED' && (enabled.body['officer'] as Record<string, unknown>)['status'] === 'active');
    check('the re-enabled officer can log in', (await gate.login(H.gate, PW.gate)) === 204);

    section('Revoke sessions — the account stays active');
    const revoked = await adminA.post('/edge/v1/officers/sessions/revoke', { targetOfficerId: gateId, reasonCode: 'DEVICE_LOST' });
    check('revokeOfficerSessions answers REVOKED with one session', revoked.body['outcome'] === 'REVOKED' && revoked.body['sessionsRevoked'] === 1);
    check('the open session is refused on its next request', (await gate.get('/edge/v1/session')).status === 401);
    check('the officer can still log in (account untouched)', (await gate.login(H.gate, PW.gate)) === 204);

    section('Cross-agency, self-escalation, last admin');
    const crossDisable = await rnp.post('/edge/v1/officers/disable', { targetOfficerId: gateId, reasonCode: 'OTHER' });
    check('an RNP administrator cannot touch an RDF officer (404 NOT_FOUND, same as nonexistent)',
      crossDisable.status === 404 && crossDisable.body['error'] === 'NOT_FOUND');
    const nonexistent = await rnp.post('/edge/v1/officers/disable', { targetOfficerId: randomUUID(), reasonCode: 'OTHER' });
    check('…byte-identical to a nonexistent officer', JSON.stringify(nonexistent.body) === JSON.stringify(crossDisable.body) && nonexistent.status === 404);
    const rnpList = await rnp.get('/edge/v1/officers');
    const rnpHandles = ((rnpList.body['officers'] ?? []) as Record<string, unknown>[]).map((o) => o['loginHandle']);
    check('the RNP list holds only RNP officers', rnpHandles.length === 1 && rnpHandles[0] === H.rnp);
    const rnpSelf = await rnp.post('/edge/v1/officers/disable', { targetOfficerId: RNP_ADMIN, reasonCode: 'OTHER' });
    check('the last active administrator cannot be disabled (409 LAST_ACTIVE_ADMIN)', rnpSelf.status === 409 && rnpSelf.body['error'] === 'LAST_ACTIVE_ADMIN');
    const selfPosts = await adminA.post('/edge/v1/officers/posts', { targetOfficerId: RDF_ADMIN_A, posts: ['decision_authority'], reasonCode: 'OTHER' });
    check('an administrator cannot change their own posts (403 SELF_MODIFICATION)', selfPosts.status === 403 && selfPosts.body['error'] === 'SELF_MODIFICATION');
    const selfDisable = await adminA.post('/edge/v1/officers/disable', { targetOfficerId: RDF_ADMIN_A, reasonCode: 'OTHER' });
    check('with another admin present, self-disable is SELF_MODIFICATION', selfDisable.status === 403 && selfDisable.body['error'] === 'SELF_MODIFICATION');
    const selfRevoke = await adminA.post('/edge/v1/officers/sessions/revoke', { targetOfficerId: RDF_ADMIN_A, reasonCode: 'OTHER' });
    check('self session revocation is refused (SELF_MODIFICATION)', selfRevoke.status === 403);

    section('A disabled ADMINISTRATOR: open session ends; the residual token is refused');
    const adminBToken = String((await iamLogin(H.adminB, PW.adminB)).body['token'] ?? '');
    check('precondition: their bearer token works against iam-service', (await iamAs(adminBToken, 'GET', '/v1/officers')).status === 200);
    const disableB = await adminA.post('/edge/v1/officers/disable', { targetOfficerId: RDF_ADMIN_B, reasonCode: 'LEFT_SERVICE' });
    check('one administrator disables another', disableB.body['outcome'] === 'DISABLED');
    const bNext = await adminB.get('/edge/v1/officers');
    check('the disabled administrator\'s open session is refused on its next request (401 revoked)', bNext.status === 401 && bNext.body['reason'] === 'revoked');
    const residual = await iamAs(adminBToken, 'GET', '/v1/officers');
    const residualWrite = await iamAs(adminBToken, 'POST', '/v1/officers', { loginHandle: `s01.residual.${runId}`, posts: ['reviewer'] });
    check('their still-unexpired bearer token is refused by iam-service (live DB re-check: 403)',
      residual.status === 403 && residualWrite.status === 403 && residual.body['error'] === 'PERMISSION_DENIED');
    const nowLast = await adminA.post('/edge/v1/officers/disable', { targetOfficerId: RDF_ADMIN_A, reasonCode: 'OTHER' });
    check('with the other admin disabled, adminA is now the last active admin (409)', nowLast.status === 409 && nowLast.body['error'] === 'LAST_ACTIVE_ADMIN');

    section('Reviewer denied');
    const reviewer = browser();
    check('reviewer signs in', (await reviewer.login(H.reviewer, PW.reviewer)) === 204);
    const reviewerList = await reviewer.get('/edge/v1/officers');
    const reviewerCreate = await reviewer.post('/edge/v1/officers', { loginHandle: `s01.byreviewer.${runId}`, posts: ['reviewer'] });
    check('the edge refuses a reviewer (403 PERMISSION_DENIED) before any upstream call',
      reviewerList.status === 403 && reviewerCreate.status === 403 && reviewerList.body['error'] === 'PERMISSION_DENIED');
    const reviewerRelease = await reviewer.post('/edge/v1/officers/activation/release', { targetOfficerId: gateId });
    check('a reviewer cannot release an activation code (403 PERMISSION_DENIED)', reviewerRelease.status === 403 && reviewerRelease.body['error'] === 'PERMISSION_DENIED');
    const reviewerToken = String((await iamLogin(H.reviewer, PW.reviewer)).body['token'] ?? '');
    const reviewerDirect = await iamAs(reviewerToken, 'POST', '/v1/officers/disable', { targetOfficerId: gateId, reasonCode: 'OTHER' });
    check('iam-service refuses a reviewer too (403 PERMISSION_DENIED)', reviewerDirect.status === 403 && reviewerDirect.body['error'] === 'PERMISSION_DENIED');
    const nothingByReviewer = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.officer_accounts WHERE login_handle = ${`s01.byreviewer.${runId}`}`;
    check('…and nothing was created', nothingByReviewer[0]?.n === 0);
    const adminAToken = String((await iamLogin(H.adminA, PW.adminA)).body['token'] ?? '');
    const smuggle = await iamAs(adminAToken, 'POST', '/v1/officers/enable', { targetOfficerId: RDF_ADMIN_B, reasonCode: 'RETURNED_TO_DUTY', agency: 'RNP' });
    check('iam-service refuses a body field the command does not accept (400) and acts on nothing',
      smuggle.status === 400 && (await db<{ status: string }[]>`SELECT status FROM public_core.officer_accounts WHERE officer_id = ${RDF_ADMIN_B}::uuid`)[0]?.status === 'disabled');

    section('Audit');
    const audits = await db<{ action: string; performed_by: string; agency: string; payload: Record<string, unknown> }[]>`
      SELECT payload->>'action' AS action, payload->>'performedBy' AS performed_by, payload->>'agency' AS agency, payload
      FROM public_core.event_outbox
      WHERE producer = 'iam-service' AND event_type = 'AUDIT_ENTRY' AND payload->>'entityId' = ${gateId}
      ORDER BY id`;
    const actions = audits.map((a) => a.action);
    check('one AUDIT_ENTRY per state-changing command on the officer, in order',
      actions.join() === 'OFFICER_CREATED,OFFICER_ACTIVATION_RELEASED,OFFICER_ACTIVATED,OFFICER_POSTS_ASSIGNED,OFFICER_DISABLED,OFFICER_ENABLED,OFFICER_SESSIONS_REVOKED',
      actions.join());
    check('administrator commands are attributed to the administrator (the release to the SECOND one); activation to the officer',
      audits.filter((a) => a.action !== 'OFFICER_ACTIVATED' && a.action !== 'OFFICER_ACTIVATION_RELEASED').every((a) => a.performed_by === RDF_ADMIN_A) &&
      audits.find((a) => a.action === 'OFFICER_ACTIVATION_RELEASED')?.performed_by === RDF_ADMIN_B &&
      audits.find((a) => a.action === 'OFFICER_ACTIVATED')?.performed_by === gateId &&
      audits.every((a) => a.agency === 'RDF'));
    const postsAudit = audits.find((a) => a.action === 'OFFICER_POSTS_ASSIGNED')?.payload['metadata'] as Record<string, unknown> | undefined;
    check('the decision_authority grant is flagged in the audit (owner decision: allowed, audited)',
      postsAudit?.['grantsDecisionAuthority'] === true && postsAudit['reasonCode'] === 'POSTING_CHANGE');
    const allIam = await db<{ text: string }[]>`
      SELECT payload::text AS text FROM public_core.event_outbox WHERE producer = 'iam-service'`;
    const eventText = allIam.map((r) => r.text).join('\n');
    check('no event carries a credential, password, code, code hash or login handle',
      !/scrypt\$|pending\$|"password"|"credential"|"code"|"codeHash"|"loginHandle"/.test(eventText) &&
      !eventText.includes(H.gate) && !eventText.includes(compactCode) && !eventText.includes(firstCode.replaceAll('-', '')));
    const refusedAudits = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public_core.event_outbox
      WHERE producer = 'iam-service' AND payload->>'entityId' IN (${RNP_ADMIN}, ${RDF_ADMIN_A})
        AND payload->>'action' LIKE 'OFFICER_%'`;
    check('refused commands stage nothing', refusedAudits[0]?.n === 0);

    section('No credential in any response');
    const everything = seenBodies.join('\n');
    check('no response body carried a scrypt digest, the pending sentinel, or a code hash',
      !everything.includes('scrypt$') && !everything.includes('pending$') &&
      !everything.includes(stored[0]?.code_hash ?? 'unreachable') && !/"credential"|"codeHash"|"code_hash"|"password"/.test(everything));
    check('the activation code appeared only in the one release answer',
      seenBodies.filter((b) => b.includes(code)).length === 1 && seenBodies.filter((b) => b.includes(secondCode)).length === 1);
  } catch (error) {
    fail += 1;
    console.error('  ✗ officer lifecycle proof crashed', error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    if (edgeServer !== undefined) await edgeServer.stop().catch(() => {});
    if (iamServer !== undefined) await iamServer.stop().catch(() => {});
    await bus.disconnect().catch(() => {});
    if (sharedConfigured) await sql.end({ timeout: 5 }).catch(() => {});
    if (proof !== undefined) await proof.end({ timeout: 5 }).catch(() => {});
    if (created) {
      try {
        await clusterAdmin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      } catch (error) {
        fail += 1;
        console.error('  ✗ failed to drop the disposable database', error instanceof Error ? error.message : String(error));
      }
    }
    await clusterAdmin.end({ timeout: 5 }).catch(() => {});
  }

  console.log(`\nOFFICER LIFECYCLE (ADR-036): ${String(pass)} passed, ${String(fail)} failed`);
  if (fail > 0) process.exitCode = 1;
}

void main();
