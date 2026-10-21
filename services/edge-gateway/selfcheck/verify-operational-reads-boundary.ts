// ADR-039 live HTTP proof for the edge's operational reads and the DPO queue.
//
// The REAL edge route table behind a real shared-http server, with a narrowly
// typed session-store/upstream double (the same harness as the BUILD-001
// boundary proof). What it proves is the edge's own behaviour:
//   • permission is enforced BEFORE any upstream spend (and the any-of roster);
//   • the query sent upstream is REBUILT (an unknown key such as `agency` is a 400);
//   • every answer is an allowlist projection: hostile upstream fields never cross,
//     a malformed upstream answer is a 502;
//   • the DPO decision: DECLINE needs grounds, EXECUTE resolves the applicant
//     server-side, and neither the applicant id nor a holding agency reaches the
//     browser.
// Database semantics (RLS, cursor, roster minimisation) are proven by the
// application-service proof against real Postgres.

import { randomUUID } from 'node:crypto';
import { startHttpServer, type HttpServer } from '@usrp/shared-http';
import { edgeCorsPolicy, edgeRoutes, type EdgeSession, type EdgeGatewayConfig } from '../src/index.js';
import { cookiePolicy } from '../src/adapters/http/cookies.js';
import { csrfTokenHash } from '../src/crypto/tokens.js';
import { InMemoryRateLimiter } from '../src/adapters/rate-limiter.memory.js';
import type { EdgeDeps } from '../src/adapters/http/guards.js';
import type { SessionRepository } from '../src/ports/session-repository.js';
import type { UpstreamCallInput, UpstreamGateway, UpstreamResult } from '../src/ports/upstream-gateway.js';

const HMAC_KEY = 'operational-reads-boundary-selfcheck-key-2030';
const CSRF_TOKEN = 'd'.repeat(64);
const SESSION_HANDLE = 'adr039-http-session-handle';
const ORIGIN = 'https://ops-ui.example.test';
const REQUEST_ID = '9c0f1cee-0000-4000-8000-0000000000aa';
const APPLICANT_ID = '9c0f1cee-0000-4000-8000-0000000000bb';
const NID_LEAK = 'NID-HASH-LEAK-9c';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; failures.push(label); console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`); }
}

const HOSTILE = { applicantId: APPLICANT_ID, nationalId: '1200380123456789', nationalIdHash: NID_LEAK, fullName: 'LEAK NAME', qrInvitationCode: 'QR-LEAK', phone: '0788000000', id: randomUUID(), policyDocument: { private: true } };

const campaignRow = {
  publicCode: 'RDF-2030', campaignLabel: 'Label', status: 'DRAFT', targetCategories: ['GENERAL_ENLISTMENT'], targetDistricts: ['GASABO'],
  registrationOpensAt: '2030-01-01T00:00:00.000Z', registrationClosesAt: '2030-02-01T00:00:00.000Z',
  examinationStartDate: '2030-03-01', examinationEndDate: '2030-03-05', allowsWalkIn: false, targetIntakeCount: null, publishedAt: null,
  createdAt: '2030-01-01T00:00:00.000Z', occupancy: { sessionCount: 1, capacityTotal: 5, hasUnboundedSession: false, registeredTotal: 2 },
};

async function main(): Promise<void> {
  const csrfHash = csrfTokenHash(HMAC_KEY, CSRF_TOKEN);
  const base: EdgeSession = {
    sessionId: randomUUID(), kind: 'officer', subjectId: '00112233-4455-4677-8899-aabbccddeeff', agency: 'RDF',
    roles: ['agency_admin'], upstreamCredential: 'synthetic-officer-jwt', upstreamExpiresAt: null,
    csrfTokenHash: csrfHash, previousCsrfTokenHash: null,
    idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'), absoluteExpiresAt: new Date('2030-01-01T12:00:00.000Z'),
  };
  let current: EdgeSession = base;
  const sessions: SessionRepository = {
    async create() { return { session: base, handle: SESSION_HANDLE, csrfToken: CSRF_TOKEN }; },
    async findByHandle(handle) { return handle === SESSION_HANDLE ? { kind: 'ACTIVE', session: current } : { kind: 'UNKNOWN' }; },
    async touch() {}, async rotate() { return null; }, async revoke() {}, async deleteExpired() { return 0; },
    async stats() { return { activeOfficer: 1, activeApplicant: 0, revoked: 0, expired: 0 }; },
  };
  const asRoles = (...roles: string[]): void => { current = { ...base, roles }; };

  const calls: UpstreamCallInput[] = [];
  let answer: (input: UpstreamCallInput) => UpstreamResult = () => { throw new Error('no stub'); };
  const upstream: UpstreamGateway = { async call(input) { calls.push(input); return answer(input); } };

  const config: EdgeGatewayConfig = {
    runtime: { serviceName: 'edge-gateway', nodeEnv: 'test', isProduction: false, port: 0, logLevel: 'error' },
    database: { url: 'postgres://selfcheck.invalid/usrp', maxConnections: 1 },
    session: { handleHmacKey: HMAC_KEY, idleTtlSeconds: 1_800, absoluteTtlSeconds: 43_200, secureCookies: false },
    cors: { origins: [ORIGIN] },
    upstream: { iamBaseUrl: 'http://127.0.0.1:1', identityBaseUrl: 'http://127.0.0.1:1', applicationBaseUrl: 'http://127.0.0.1:1', schedulingBaseUrl: 'http://127.0.0.1:1', fieldSyncBaseUrl: 'http://127.0.0.1:1', biometricBaseUrl: 'http://127.0.0.1:1', timeoutMs: 8_000, maxResponseBytes: 1_048_576 },
    rateLimits: { loginPerMinute: 20, otpPerMinute: 20, verifyIdentityPerMinute: 20, applicantSubmitPerMinute: 20, trustedProxyHops: 0 },
    auth: { authPublicKeyPem: 'unused-by-the-stub-upstream', jwtIssuer: 'usrp', jwtAudience: 'usrp-services' },
  };
  const deps: EdgeDeps = {
    config, cookies: cookiePolicy(false), sessions, upstream, limiter: new InMemoryRateLimiter(),
    audit: { log() {}, stats() {}, fault() {} }, now: () => new Date('2030-01-01T00:00:00.000Z'),
  };

  let server: HttpServer | undefined;
  try {
    server = await startHttpServer({
      serviceName: 'edge-operational-reads-selfcheck', port: 0, host: '127.0.0.1',
      routes: edgeRoutes(deps), cors: edgeCorsPolicy(config), handleSignals: false, logger: () => {},
    });
    const root = server.url;
    const cookie = `${deps.cookies.sessionCookieName}=${SESSION_HANDLE}; ${deps.cookies.csrfCookieName}=${CSRF_TOKEN}`;
    const get = async (path: string): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
      const res = await fetch(`${root}${path}`, { headers: { cookie } });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not json */ }
      return { status: res.status, text, json };
    };
    const post = async (path: string, body: unknown, csrf = true): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
      const res = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': CSRF_TOKEN } : {}) },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not json */ }
      return { status: res.status, text, json };
    };
    const before = (): number => calls.length;

    console.log('\n── Admin campaign reads ──');
    answer = () => ({ status: 200, body: { agency: 'RDF', campaigns: [{ ...campaignRow, ...HOSTILE }], total: 1, nextCursor: null, ...HOSTILE } });
    let n = before();
    const list = await get('/edge/v1/campaigns/admin?q=rdf&status=DRAFT&status=registration_open&limit=10');
    check('agency_admin lists campaigns → 200', list.status === 200, list.text);
    check('hostile upstream fields never cross', !list.text.includes(NID_LEAK) && !list.text.includes('LEAK NAME') && !list.text.includes('QR-LEAK') && !list.text.includes(APPLICANT_ID) && !list.text.includes('policyDocument'));
    const q = calls[n]?.query ?? {};
    check('query is REBUILT (status list normalised, nothing extra)', JSON.stringify(q) === JSON.stringify({ q: 'rdf', status: 'DRAFT,REGISTRATION_OPEN', limit: '10' }), JSON.stringify(q));
    n = before();
    check('an `agency` query key is refused outright, no upstream call', (await get('/edge/v1/campaigns/admin?agency=RNP')).status === 400 && calls.length === n);
    check('an unknown query key is refused', (await get('/edge/v1/campaigns/admin?sort=asc')).status === 400 && calls.length === n);
    check('a malformed cursor is refused before upstream', (await get('/edge/v1/campaigns/admin?cursor=a b')).status === 400 && calls.length === n);
    asRoles('screening_officer');
    check('wrong role → 403 PERMISSION_DENIED before upstream', (await get('/edge/v1/campaigns/admin')).text.includes('PERMISSION_DENIED') && calls.length === n);
    asRoles('agency_admin');
    answer = () => ({ status: 200, body: { agency: 'RDF', campaigns: [{ ...campaignRow, status: 42 }], total: 1, nextCursor: null } });
    check('malformed upstream row → 502 UPSTREAM_CONTRACT_MISMATCH (all or nothing)', (await get('/edge/v1/campaigns/admin')).status === 502);
    answer = () => ({ status: 404, body: { error: 'NOT_FOUND' } });
    const detail404 = await get('/edge/v1/campaigns/admin/detail?publicCode=rdf-2030');
    check('detail: upstream 404 → bare 404', detail404.status === 404 && detail404.text === '{"error":"NOT_FOUND"}', detail404.text);
    check('detail: publicCode is required', (await get('/edge/v1/campaigns/admin/detail')).status === 400);
    check('detail: public code is upper-cased and validated', calls.at(-1)?.query?.['publicCode'] === 'RDF-2030' && (await get('/edge/v1/campaigns/admin/detail?publicCode=%27%3B--')).status === 400);

    console.log('\n── Application search ──');
    answer = () => ({ status: 200, body: { agency: 'RDF', applications: [{ applicationId: randomUUID(), processingCode: 'RDF-00001', category: 'GENERAL_ENLISTMENT', status: 'SUBMITTED', submittedAt: '2030-01-01T00:00:00.000Z', ...HOSTILE }], total: 41, nextCursor: 'abc_-123' } });
    n = before();
    asRoles('reviewer');
    const search = await get('/edge/v1/applications/search?status=submitted,slot_assigned&category=general_enlistment&campaign=rdf-2030&district=gasabo&submittedFrom=2030-01-01&submittedTo=2030-01-31&limit=25&cursor=abc_-123');
    check('reviewer searches → 200 with total and cursor', search.status === 200 && search.json['total'] === 41 && search.json['nextCursor'] === 'abc_-123', search.text);
    check('row has exactly the allowlisted keys', Object.keys((search.json['applications'] as Record<string, unknown>[])[0] ?? {}).sort().join() === 'applicationId,category,processingCode,status,submittedAt');
    check('no applicant id, NID, name, token or phone', !/LEAK|1200380123456789|0788000000/.test(search.text) && !search.text.includes(APPLICANT_ID));
    check('upstream query rebuilt from validated values', JSON.stringify(calls[n]?.query) === JSON.stringify({ status: 'SUBMITTED,SLOT_ASSIGNED', category: 'GENERAL_ENLISTMENT', campaign: 'RDF-2030', district: 'GASABO', submittedFrom: '2030-01-01', submittedTo: '2030-01-31', limit: '25', cursor: 'abc_-123' }), JSON.stringify(calls[n]?.query));
    n = before();
    check('bad date / limit / status never reach upstream', (await get('/edge/v1/applications/search?submittedFrom=yesterday')).status === 400 && (await get('/edge/v1/applications/search?limit=9999')).status === 400 && (await get('/edge/v1/applications/search?status=a;b')).status === 400 && calls.length === n);
    answer = () => ({ status: 200, body: { agency: 'RDF', applications: [], total: 0, nextCursor: null } });
    const empty = await get('/edge/v1/applications/search?status=ACCEPTED');
    check('filter-empty: 200, total 0, no cursor', empty.status === 200 && empty.json['total'] === 0 && empty.json['nextCursor'] === null);
    asRoles('dpo');
    n = before();
    check('dpo (no application.read) → 403 before upstream', (await get('/edge/v1/applications/search')).status === 403 && calls.length === n);

    console.log('\n── Venue roster ──');
    const rosterBody = { agency: 'RDF', venue: { venueName: 'Rehearsal Venue — Gasabo', district: 'GASABO', examDate: '2030-03-02', reportingTimeHour: 7, capacityLimit: 300, registeredCount: 1 }, candidates: [{ processingCode: 'RDF-00001', category: 'GENERAL_ENLISTMENT', status: 'SLOT_ASSIGNED', admission: 'NOT_ADMITTED', requiredPaperItems: ['NATIONAL_ID'], ...HOSTILE }], truncated: false };
    answer = () => ({ status: 200, body: rosterBody });
    const path = '/edge/v1/gate/roster?campaign=rdf-2030&district=gasabo&examDate=2030-03-02';
    for (const role of ['screening_officer', 'field_supervisor'] as const) {
      asRoles(role);
      const res = await get(path);
      check(`${role} → 200 (admission.gate OR field.score.sync)`, res.status === 200, res.text);
      if (role === 'screening_officer') {
        check('roster candidate keys are exactly the allowlist', Object.keys((res.json['candidates'] as Record<string, unknown>[])[0] ?? {}).sort().join() === 'admission,category,processingCode,requiredPaperItems,status');
        check('roster never carries a name, NID, hash, applicant id, token or phone', !/LEAK|1200380123456789|0788000000/.test(res.text) && !res.text.includes(APPLICANT_ID) && !res.text.includes(NID_LEAK));
      }
    }
    asRoles('reviewer');
    n = before();
    check('reviewer (neither permission) → 403 before upstream', (await get(path)).status === 403 && calls.length === n);
    asRoles('screening_officer');
    check('roster needs campaign, district and examDate', (await get('/edge/v1/gate/roster?campaign=RDF-2030')).status === 400 && calls.length === n);
    answer = () => ({ status: 200, body: { ...rosterBody, candidates: [{ processingCode: 'RDF-1', category: 'X', status: 'S', admission: 'MAYBE', requiredPaperItems: [] }] } });
    check('an off-vocabulary admission state → 502', (await get(path)).status === 502);

    console.log('\n── DPO queue and decision ──');
    asRoles('dpo');
    answer = () => ({ status: 200, body: { requests: [{ requestId: REQUEST_ID, applicantId: APPLICANT_ID, requestedAt: '2030-01-01T00:00:00.000Z', decisionNote: 'x' }] } });
    const queue = await get('/edge/v1/erasure-requests');
    check('dpo reads the queue → 200', queue.status === 200, queue.text);
    check('the applicant id NEVER crosses the edge', !queue.text.includes(APPLICANT_ID) && !queue.text.includes('applicantId'));
    check('queue row is { requestId, requestedAt } only', JSON.stringify(queue.json) === JSON.stringify({ requests: [{ requestId: REQUEST_ID, requestedAt: '2030-01-01T00:00:00.000Z' }] }), queue.text);
    n = before();
    asRoles('agency_admin');
    check('agency_admin (no erasure.queue.read) → 403 before upstream', (await get('/edge/v1/erasure-requests')).status === 403 && calls.length === n);
    check('agency_admin may not decide either', (await post('/edge/v1/erasure-requests/decision', { requestId: REQUEST_ID, decision: 'DECLINE', grounds: 'x' })).status === 403 && calls.length === n);
    asRoles('dpo');
    check('decision without CSRF → 403 before upstream', (await post('/edge/v1/erasure-requests/decision', { requestId: REQUEST_ID, decision: 'DECLINE', grounds: 'x' }, false)).status === 403 && calls.length === n);

    const decide = '/edge/v1/erasure-requests/decision';
    for (const [label, body] of [
      ['DECLINE without grounds', { requestId: REQUEST_ID, decision: 'DECLINE' }],
      ['DECLINE with blank grounds', { requestId: REQUEST_ID, decision: 'DECLINE', grounds: '   ' }],
      ['DECLINE with 201-character grounds', { requestId: REQUEST_ID, decision: 'DECLINE', grounds: 'x'.repeat(201) }],
      ['EXECUTE carrying grounds', { requestId: REQUEST_ID, decision: 'EXECUTE', grounds: 'why' }],
      ['unknown decision', { requestId: REQUEST_ID, decision: 'DELETE' }],
      ['a client-supplied applicantId', { requestId: REQUEST_ID, decision: 'EXECUTE', applicantId: APPLICANT_ID }],
      ['a non-UUID request id', { requestId: 'not-a-uuid', decision: 'EXECUTE' }],
    ] as const) {
      const res = await post(decide, body);
      check(`${label} → 400, no upstream call`, res.status === 400 && calls.length === n, `${res.status} ${res.text}`);
    }

    answer = () => ({ status: 200, body: { status: 'DECLINED' } });
    n = before();
    const declined = await post(decide, { requestId: REQUEST_ID, decision: 'DECLINE', grounds: '  Retention required by law.  ' });
    check('DECLINE with grounds → 200 DECLINED', declined.status === 200 && declined.json['decision'] === 'DECLINED', declined.text);
    check('the decline upstream body is { requestId, note } (trimmed)', JSON.stringify(calls[n]?.body) === JSON.stringify({ requestId: REQUEST_ID, note: 'Retention required by law.' }) && calls[n]?.operation.id === 'erasureDecline');
    answer = () => ({ status: 409, body: { status: 'NOT_PENDING', currentStatus: 'EXECUTED' } });
    const notPending = await post(decide, { requestId: REQUEST_ID, decision: 'DECLINE', grounds: 'again' });
    check('already decided → 409 NOT_PENDING (status of the earlier decision withheld)', notPending.status === 409 && notPending.text === '{"error":"NOT_PENDING"}', notPending.text);

    let executeBody: unknown = null;
    const pending = { requests: [{ requestId: REQUEST_ID, applicantId: APPLICANT_ID, requestedAt: '2030-01-01T00:00:00.000Z' }] };
    const executeAnswer = (status: number, body: unknown) => (input: UpstreamCallInput): UpstreamResult => {
      if (input.operation.id === 'erasureQueue') return { status: 200, body: pending };
      executeBody = input.body;
      return { status, body };
    };
    n = before();
    answer = executeAnswer(200, { status: 'ERASED' });
    const executed = await post(decide, { requestId: REQUEST_ID, decision: 'EXECUTE' });
    check('EXECUTE → 200 EXECUTED', executed.status === 200 && executed.json['decision'] === 'EXECUTED', executed.text);
    check('the erasure road received the applicant resolved SERVER-SIDE', JSON.stringify(executeBody) === JSON.stringify({ applicantId: APPLICANT_ID }) && calls.slice(n).map((c) => c.operation.id).join() === 'erasureQueue,erasureExecute');
    check('…and the browser never saw that applicant id', !executed.text.includes(APPLICANT_ID));
    answer = executeAnswer(200, { status: 'ALREADY_ERASED' });
    check('ALREADY_ERASED is an idempotent success', (await post(decide, { requestId: REQUEST_ID, decision: 'EXECUTE' })).json['decision'] === 'EXECUTED');
    answer = executeAnswer(409, { status: 'REFUSED_ACTIVE_APPLICATION', agency: 'RNP', currentStatus: 'ACCEPTED' });
    const active = await post(decide, { requestId: REQUEST_ID, decision: 'EXECUTE' });
    check('REFUSED_ACTIVE_APPLICATION → 409 bare (no agency, no application status)', active.status === 409 && active.text === '{"error":"REFUSED_ACTIVE_APPLICATION"}', active.text);
    answer = executeAnswer(409, { status: 'REFUSED_ACCEPT_LOCKED', lockedByAgency: 'RNP' });
    const locked = await post(decide, { requestId: REQUEST_ID, decision: 'EXECUTE' });
    check('REFUSED_ACCEPT_LOCKED → 409 without lockedByAgency', locked.status === 409 && locked.text === '{"error":"REFUSED_ACCEPT_LOCKED"}', locked.text);
    n = before();
    answer = (input) => (input.operation.id === 'erasureQueue' ? { status: 200, body: { requests: [] } } : { status: 500, body: null });
    const gone = await post(decide, { requestId: REQUEST_ID, decision: 'EXECUTE' });
    check('EXECUTE for a request not in the pending queue → 404 and the erasure road is NEVER called', gone.status === 404 && calls.slice(n).map((c) => c.operation.id).join() === 'erasureQueue', `${gone.status} ${calls.slice(n).map((c) => c.operation.id).join()}`);
    answer = () => ({ status: 503, body: null });
    check('upstream unavailable → 503, never a partial success', (await post(decide, { requestId: REQUEST_ID, decision: 'DECLINE', grounds: 'g' })).status === 503);
  } finally {
    await server?.stop();
  }

  console.log('\n────────────────────────────────────────');
  if (fail === 0) {
    console.log(`OPERATIONAL READS EDGE BOUNDARY PROVEN — ${String(pass)} checks ✓`);
    process.exit(0);
  }
  console.error(`${String(fail)} of ${String(pass + fail)} checks failed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error('SELF-CHECK CRASHED:', error);
  process.exit(1);
});
