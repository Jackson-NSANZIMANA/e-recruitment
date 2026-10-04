// ══════════════════════════════════════════════════════════════════
// identity-service — APPLICANT SUBMIT GATEWAY proof (ADR-027, zero infra)
//
// Proves the citizen submit bridge WITHOUT PostgreSQL, Kafka, NIDA or a
// live iam-service: the applicant-auth ROUTES are booted on a real socket
// against a stubbed ApplicantAuthService (session → applicant resolution)
// and the REAL HttpApplicationsGateway pointed at a scripted fetch double
// for iam (client-credentials mint) and application-service (the front
// door). Every claim is asserted against what actually crossed the wire:
//
//   • the session resolves the subject — a different session files as a
//     different applicant, and a body `applicantId` is REFUSED, never
//     trusted;
//   • `channel` is always WEB, set server-side, and a body `channel` is
//     refused;
//   • exactly one UUID Idempotency-Key is required (missing / malformed /
//     duplicated → 400) and the validated key is forwarded EXACTLY;
//   • the identity-service system token is fetched from iam with the
//     configured client credentials and is the ONLY credential on the
//     upstream call — the browser's session token never crosses;
//   • first submission, replay (201 + Idempotency-Replayed: true),
//     ALREADY_APPLIED and identifier-free KEY_REUSED all survive the
//     bridge, as do every business precondition answer;
//   • malformed or unexpected upstream bodies are refused safely (502,
//     nothing echoed) and dependency faults never masquerade as answers;
//   • no secret, session token, idempotency key, applicant id or raw
//     upstream body ever appears in the process output.
//
//   npx tsx services/identity-service/selfcheck/verify-applicant-submit-gateway.ts
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  applicantAuthRoutes,
  HttpApplicationsGateway,
  ME_APPLICATIONS_PATH,
  type ApplicantAuthService,
} from '../src/index.js';
import { startHttpServer, type HttpServer } from '@usrp/shared-http';

// ── Harness ──────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];
/** Every line the process writes, so the no-secrets sweep is honest. */
const consoleCapture: string[] = [];

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
console.log = (...args: unknown[]): void => {
  consoleCapture.push(args.map(String).join(' '));
  originalLog(...args);
};
console.error = (...args: unknown[]): void => {
  consoleCapture.push(args.map(String).join(' '));
  originalError(...args);
};
console.warn = (...args: unknown[]): void => {
  consoleCapture.push(args.map(String).join(' '));
  originalWarn(...args);
};

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

function section(title: string): void {
  console.log(`\n══ ${title}`);
}

// ── Fixtures (ad27 namespace — recognisably this proof's) ──────────

const APPLICANT_A = 'ad270000-0000-4000-8000-0000000000a1';
const APPLICANT_B = 'ad270000-0000-4000-8000-0000000000b2';
const SESSION_TOKEN_A = 'proof-opaque-applicant-session-token-A';
const SESSION_TOKEN_B = 'proof-opaque-applicant-session-token-B';
const SESSION_TOKEN_UNKNOWN = 'proof-opaque-applicant-session-token-X';

const IAM_BASE = 'http://iam.proof.internal';
const APP_BASE = 'http://application.proof.internal';
const CLIENT_ID = 'proof.identity-service';
const CLIENT_SECRET = 'Pr00f#Identity!SubmitSecret';

const APPLICATION_ID = 'ad270000-0000-4000-8000-0000000000c3';
const PROCESSING_CODE = 'RDF-77001';
const AGENCY = 'RDF';
const KEY_REUSED_REASON = 'This Idempotency-Key was already used for a different submission.';

// ── The scripted upstream ─────────────────────────────────────

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function lowerKeys(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers !== null && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return out;
}

/**
 * A fetch double for exactly two hosts: the iam token endpoint (always
 * mints fresh tokens, counting calls) and application-service's front door
 * (scripted per case). Nothing is logged; everything is RECORDED so the
 * proof can assert what actually crossed the wire.
 */
class ScriptedUpstream {
  readonly iamCalls: RecordedCall[] = [];
  readonly appCalls: RecordedCall[] = [];
  /** Tokens handed out by iam, in mint order. */
  readonly mintedTokens: string[] = [];
  #mintCount = 0;
  /** The response the next application-service call answers with (one-shot). */
  #nextAppResponse: (() => Response) | null = null;
  /** When set, the next application-service call fails like a transport. */
  #nextAppFails = false;

  scriptNextApp(response: () => Response): void {
    this.#nextAppResponse = response;
  }

  scriptNextAppFailure(): void {
    this.#nextAppFails = true;
  }

  fetch = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: lowerKeys(init?.headers),
      body: init?.body === undefined ? null : JSON.parse(String(init?.body)),
    };
    if (url.startsWith(`${IAM_BASE}/`)) {
      this.iamCalls.push(call);
      this.#mintCount += 1;
      const token = `proof-minted-system-token-${this.#mintCount}`;
      this.mintedTokens.push(token);
      return Promise.resolve(json(200, { token, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }));
    }
    this.appCalls.push(call);
    if (this.#nextAppFails) {
      this.#nextAppFails = false;
      return Promise.reject(new TypeError('fetch failed (scripted transport fault)'));
    }
    // One-shot: an unscripted call answers with the default first-submission
    // response, so a proof case can never inherit the previous case's script.
    const scripted = this.#nextAppResponse;
    this.#nextAppResponse = null;
    return Promise.resolve(scripted === null ? defaultSubmitResponse() : scripted());
  };
}

function defaultSubmitResponse(): Response {
  return json(201, { status: 'SUBMITTED', applicationId: APPLICATION_ID, processingCode: PROCESSING_CODE, agency: AGENCY });
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return headers === undefined
    ? new Response(JSON.stringify(body), { status })
    : new Response(JSON.stringify(body), { status, headers });
}

// ── The stub session service ─────────────────────────────────

/**
 * Session resolution without PostgreSQL: three fixed opaque tokens, each
 * mapping to its applicant (or none). The route under test only ever calls
 * authenticateSession on this shape.
 */
const stubApplicantAuth = {
  authenticateSession: async (token: string): Promise<string | null> => {
    if (token === SESSION_TOKEN_A) return APPLICANT_A;
    if (token === SESSION_TOKEN_B) return APPLICANT_B;
    return null;
  },
  logout: async (): Promise<void> => {},
} as unknown as ApplicantAuthService;

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const upstream = new ScriptedUpstream();
  const gateway = new HttpApplicationsGateway({
    iamBaseUrl: IAM_BASE,
    applicationBaseUrl: APP_BASE,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchImpl: upstream.fetch as unknown as typeof fetch,
  });

  const server: HttpServer = await startHttpServer({
    serviceName: 'applicant-submit-gateway-proof',
    port: 0,
    host: '127.0.0.1',
    routes: applicantAuthRoutes(stubApplicantAuth, gateway),
    handleSignals: false,
  });
  const base = server.url;

  async function call(
    options: {
      sessionToken?: string | null;
      idempotencyKey?: string | null;
      body?: unknown;
    } = {},
  ): Promise<{ status: number; text: string; headers: Headers }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.sessionToken !== null) {
      headers.authorization = `Bearer ${options.sessionToken ?? SESSION_TOKEN_A}`;
    }
    if (options.idempotencyKey !== null) {
      headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
    }
    const response = await fetch(`${base}${ME_APPLICATIONS_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body ?? { category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2026/1001' }),
    });
    return { status: response.status, text: await response.text(), headers: response.headers };
  }

  /** Send TWO Idempotency-Key headers — fetch cannot, raw http can. */
  function callWithDuplicateKeys(keyA: string, keyB: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        new URL(ME_APPLICATIONS_PATH, base),
        { method: 'POST', headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SESSION_TOKEN_A}`,
          'idempotency-key': [keyA, keyB],
        } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ category: 'GENERAL_ENLISTMENT', nesaIndexNumber: 'RW2026/1001' }));
    });
  }

  try {
    // ── 1. First submission: exactly what crosses the wire ───────
    section('1. First submission — session-derived subject, pinned channel, exact key');
    const iamCallsBefore = upstream.iamCalls.length;
    const appCallsBefore = upstream.appCalls.length;
    const KEY = randomUUID();
    const first = await call({ idempotencyKey: KEY });
    check('first submission is 201', first.status === 201, first.text);
    check(
      'the body carries the first submission identifiers',
      first.text.includes(APPLICATION_ID) &&
        first.text.includes(PROCESSING_CODE) &&
        first.text.includes('"agency":"RDF"'),
      first.text,
    );
    check(
      'no replay header on a first submission',
      first.headers.get('idempotency-replayed') === null,
    );

    check('exactly one iam token mint preceded it', upstream.iamCalls.length - iamCallsBefore === 1);
    check('exactly one application-service call was made', upstream.appCalls.length - appCallsBefore === 1);
    const appCall = upstream.appCalls[upstream.appCalls.length - 1];
    check('the upstream call is POST /v1/applications', appCall?.method === 'POST' && appCall?.url === `${APP_BASE}/v1/applications`, `${appCall?.method} ${appCall?.url}`);
    check(
      'the idempotency key is forwarded EXACTLY',
      appCall?.headers['idempotency-key'] === KEY,
      String(appCall?.headers['idempotency-key']),
    );
    check(
      'the body subject is the SESSION-derived applicant',
      (appCall?.body as Record<string, unknown>)?.['applicantId'] === APPLICANT_A,
      JSON.stringify(appCall?.body),
    );
    check(
      'the channel is pinned to WEB server-side',
      (appCall?.body as Record<string, unknown>)?.['channel'] === 'WEB',
    );
    check(
      'the body is exactly the allowlisted fields',
      appCall?.body !== null &&
        typeof appCall?.body === 'object' &&
        Object.keys(appCall.body as Record<string, unknown>).sort().join(',') ===
          'applicantId,category,channel,nesaIndexNumber',
      JSON.stringify(appCall?.body),
    );
    const iamCall = upstream.iamCalls[upstream.iamCalls.length - 1];
    check(
      'iam minted with the CONFIGURED client credentials',
      (iamCall?.body as Record<string, unknown>)?.['clientId'] === CLIENT_ID &&
        (iamCall?.body as Record<string, unknown>)?.['clientSecret'] === CLIENT_SECRET,
    );
    check(
      'the upstream credential is the MINTED system token',
      appCall?.headers['authorization'] === `Bearer ${upstream.mintedTokens[0]}`,
      String(appCall?.headers['authorization']),
    );
    check(
      "the browser's session token is nowhere in the upstream request",
      !JSON.stringify(appCall).includes(SESSION_TOKEN_A),
    );

    // ── 2. The session, not the body, decides the subject ─────────
    section('2. Self-binding: the session resolves the subject');
    const KEY_B = randomUUID();
    const asB = await call({ sessionToken: SESSION_TOKEN_B, idempotencyKey: KEY_B });
    check('applicant B files as B (201)', asB.status === 201, asB.text);
    const bCall = upstream.appCalls[upstream.appCalls.length - 1];
    check(
      'a different session produces a different upstream subject',
      (bCall?.body as Record<string, unknown>)?.['applicantId'] === APPLICANT_B,
      JSON.stringify(bCall?.body),
    );

    const forged = await call({
      body: { applicantId: '00000000-0000-4000-8000-0000000000ff', category: 'GENERAL_ENLISTMENT' },
    });
    check('a body applicantId is REFUSED with 400', forged.status === 400, forged.text);
    check(
      'the refusal names FORBIDDEN_FIELD',
      forged.text.includes('FORBIDDEN_FIELD'),
      forged.text,
    );
    check(
      'the forged request never reached application-service',
      upstream.appCalls.length - 1 === upstream.appCalls.findIndex((c) => c === bCall),
    );

    const channelForged = await call({
      body: { category: 'GENERAL_ENLISTMENT', channel: 'USSD' },
    });
    check('a body channel is REFUSED with 400', channelForged.status === 400, channelForged.text);
    check('the channel forgery never reached application-service either', upstream.appCalls.every((c) => (c.body as Record<string, unknown>)?.['channel'] === 'WEB'));

    const noSession = await call({ sessionToken: SESSION_TOKEN_UNKNOWN });
    check('an unknown session is a uniform 401', noSession.status === 401, noSession.text);
    const bare = await call({ sessionToken: null });
    check('no Authorization header is a uniform 401', bare.status === 401, bare.text);

    // ── 3. The idempotency key contract ─────────────────────────
    section('3. Exactly one UUID Idempotency-Key');
    const appCallsBeforeKeys = upstream.appCalls.length;
    const missing = await call({ idempotencyKey: null });
    check('a missing key is 400 INVALID_IDEMPOTENCY_KEY', missing.status === 400 && missing.text.includes('INVALID_IDEMPOTENCY_KEY'), missing.text);
    const malformed = await call({ idempotencyKey: 'not-a-uuid' });
    check('a non-UUID key is 400 INVALID_IDEMPOTENCY_KEY', malformed.status === 400 && malformed.text.includes('INVALID_IDEMPOTENCY_KEY'), malformed.text);
    const duplicated = await callWithDuplicateKeys(randomUUID(), randomUUID());
    check('a duplicated key header is 400 (never resolved by picking one)', duplicated === 400, String(duplicated));
    check(
      'none of the bad-key requests reached application-service',
      upstream.appCalls.length === appCallsBeforeKeys,
    );
    const badCategory = await call({ body: { category: 'NOT_A_CATEGORY' } });
    check('an unknown category is 400 INVALID_CATEGORY', badCategory.status === 400 && badCategory.text.includes('INVALID_CATEGORY'), badCategory.text);

    // ── 4. Replay ───────────────────────────────────────────────
    section('4. Replay survives the bridge');
    const REPLAY_KEY = randomUUID();
    upstream.scriptNextApp(() =>
      json(
        201,
        { status: 'SUBMITTED', applicationId: APPLICATION_ID, processingCode: PROCESSING_CODE, agency: AGENCY },
        { 'Idempotency-Replayed': 'true' },
      ),
    );
    const replay = await call({ idempotencyKey: REPLAY_KEY });
    check('a replay keeps its 201', replay.status === 201, replay.text);
    check(
      'the replay sets Idempotency-Replayed: true for the browser',
      replay.headers.get('idempotency-replayed') === 'true',
      String(replay.headers.get('idempotency-replayed')),
    );
    check(
      'the replayed body is the FIRST submission, identifiers intact',
      replay.text.includes(APPLICATION_ID) && replay.text.includes(PROCESSING_CODE),
      replay.text,
    );
    const replayCall = upstream.appCalls[upstream.appCalls.length - 1];
    check(
      'the retry forwarded the SAME key',
      replayCall?.headers['idempotency-key'] === REPLAY_KEY,
      String(replayCall?.headers['idempotency-key']),
    );

    // ── 5. Live duplicate and key reuse ──────────────────────────
    section('5. ALREADY_APPLIED keeps ids; KEY_REUSED keeps none');
    upstream.scriptNextApp(() =>
      json(409, { status: 'ALREADY_APPLIED', applicationId: APPLICATION_ID, processingCode: PROCESSING_CODE, agency: AGENCY }),
    );
    const duplicate = await call();
    check('a live duplicate is 409 ALREADY_APPLIED', duplicate.status === 409 && duplicate.text.includes('ALREADY_APPLIED'), duplicate.text);
    check(
      'the duplicate names the application already on file',
      duplicate.text.includes(APPLICATION_ID) && duplicate.text.includes(PROCESSING_CODE),
      duplicate.text,
    );

    upstream.scriptNextApp(() =>
      // Malicious upstream: identifiers on a KEY_REUSED answer. The bridge
      // must still surface the identifier-free shape.
      json(409, { status: 'KEY_REUSED', reason: KEY_REUSED_REASON, applicationId: 'ad270000-0000-4000-8000-0000000000d4', processingCode: 'RDF-99999' }),
    );
    const reused = await call();
    check('key reuse is 409 KEY_REUSED', reused.status === 409 && reused.text.includes('KEY_REUSED'), reused.text);
    check(
      'key reuse is IDENTIFIER-FREE even when upstream misbehaves',
      !reused.text.includes('applicationId') && !reused.text.includes('processingCode'),
      reused.text,
    );
    check('the reuse reason survives (static text, not an identifier)', reused.text.includes(KEY_REUSED_REASON), reused.text);

    // ── 6. Business preconditions pass through unchanged ─────────
    section('6. Every business answer is preserved');
    upstream.scriptNextApp(() => json(404, { status: 'APPLICANT_NOT_FOUND' }));
    const notFound = await call();
    check('APPLICANT_NOT_FOUND stays a 404', notFound.status === 404 && notFound.text.includes('APPLICANT_NOT_FOUND'), notFound.text);

    upstream.scriptNextApp(() => json(409, { status: 'IDENTITY_NOT_VERIFIED' }));
    const unverified = await call();
    check('IDENTITY_NOT_VERIFIED stays a 409', unverified.status === 409 && unverified.text.includes('IDENTITY_NOT_VERIFIED'), unverified.text);

    upstream.scriptNextApp(() => json(422, { status: 'INVALID_ACADEMIC_INPUT', reason: 'Category "GENERAL_ENLISTMENT" requires a NESA index number.' }));
    const academic = await call({ body: { category: 'GENERAL_ENLISTMENT' } });
    check('INVALID_ACADEMIC_INPUT stays a 422 with its reason', academic.status === 422 && academic.text.includes('INVALID_ACADEMIC_INPUT') && academic.text.includes('NESA'), academic.text);

    upstream.scriptNextApp(() => json(409, { status: 'NO_OPEN_CAMPAIGN', agency: 'RDF' }));
    const noCampaign = await call();
    check('NO_OPEN_CAMPAIGN stays a 409 naming the agency', noCampaign.status === 409 && noCampaign.text.includes('NO_OPEN_CAMPAIGN') && noCampaign.text.includes('RDF'), noCampaign.text);

    // ── 7. Malformed and unexpected upstream responses ───────────
    section('7. Unexpected upstream responses fail safely');
    const appCallsBeforeMalformed = upstream.appCalls.length;
    upstream.scriptNextApp(() => json(200, { weird: 'not-the-contract' }));
    const wrongStatus = await call();
    check('an unexpected 200 is a generic 502, never the body', wrongStatus.status === 502 && !wrongStatus.text.includes('weird'), wrongStatus.text);
    check('the 502 names the mismatch, not the content', wrongStatus.text.includes('UPSTREAM_CONTRACT_MISMATCH'), wrongStatus.text);

    upstream.scriptNextApp(() => json(201, { status: 'SUBMITTED', applicationId: APPLICATION_ID }));
    const halfBody = await call();
    check('a 201 missing fields is a 502 (fail safe, no partial ids)', halfBody.status === 502 && !halfBody.text.includes(APPLICATION_ID), halfBody.text);

    upstream.scriptNextApp(() =>
      json(201, { status: 'SUBMITTED', applicationId: APPLICATION_ID, processingCode: PROCESSING_CODE, agency: AGENCY }, { 'Idempotency-Replayed': 'yes-actually' }),
    );
    const weirdReplayHeader = await call();
    check('a non-"true" replay header value is unexpected → 502', weirdReplayHeader.status === 502, weirdReplayHeader.text);

    upstream.scriptNextApp(() => json(201, { status: 'SOMETHING_ELSE', applicationId: APPLICATION_ID, processingCode: PROCESSING_CODE, agency: AGENCY }));
    const wrongStatusString = await call();
    check('a 201 with the wrong status string is a 502', wrongStatusString.status === 502, wrongStatusString.text);
    check('the malformed calls all reached upstream (and were refused here)', upstream.appCalls.length - appCallsBeforeMalformed === 4);

    // ── 8. Dependency failures ──────────────────────────────────
    section('8. Dependency failures are honest and never answers');
    upstream.scriptNextAppFailure();
    const transportFault = await call();
    check('a transport fault is 502 DEPENDENCY_UNAVAILABLE', transportFault.status === 502 && transportFault.text.includes('DEPENDENCY_UNAVAILABLE'), transportFault.text);

    upstream.scriptNextApp(() => json(500, { error: 'APPLICATION_PERSISTENCE_ERROR' }));
    const appFiveHundred = await call();
    check('an upstream 5xx is 502 DEPENDENCY_UNAVAILABLE (nothing was written)', appFiveHundred.status === 502 && appFiveHundred.text.includes('DEPENDENCY_UNAVAILABLE'), appFiveHundred.text);

    // A rejected system token: the first call fails honestly; the NEXT call
    // re-mints (cache dropped) and succeeds — no blind retry of the write.
    upstream.scriptNextApp(() => json(401, { error: 'UNAUTHENTICATED' }));
    const tokenRejected = await call();
    check('a rejected system token is 502 (never a citizen-facing answer)', tokenRejected.status === 502, tokenRejected.text);
    const mintsBefore = upstream.mintedTokens.length;
    const afterRejection = await call();
    check('the next submit mints a FRESH token and succeeds', afterRejection.status === 201 && upstream.mintedTokens.length === mintsBefore + 1, afterRejection.text);
    const lastCall = upstream.appCalls[upstream.appCalls.length - 1];
    check(
      'the fresh token is the one used',
      lastCall?.headers['authorization'] === `Bearer ${upstream.mintedTokens[upstream.mintedTokens.length - 1]}`,
    );

    // ── 9. Nothing sensitive in the process output ───────────────
    section('9. No secret, key, subject or upstream body is ever logged');
    const output = consoleCapture.join('\n');
    check('the client secret never appears in output', !output.includes(CLIENT_SECRET));
    check('a session token never appears in output', !output.includes(SESSION_TOKEN_A) && !output.includes(SESSION_TOKEN_B));
    check('an idempotency key never appears in output', !upstream.appCalls.some((c) => c.headers['idempotency-key'] !== undefined && output.includes(c.headers['idempotency-key'])));
    check('an applicant id never appears in output', !output.includes(APPLICANT_A) && !output.includes(APPLICANT_B));
    check('a raw upstream body never appears in output', !output.includes('weird') && !output.includes('SOMETHING_ELSE'));
  } finally {
    await server.stop();
  }

  console.log(`\n────────────────────────────────────────`);
  if (fail === 0) {
    console.log(`APPLICANT SUBMIT GATEWAY GREEN — ${pass} checks, bridge proven without infrastructure ✓`);
    process.exit(0);
  }
  console.error(`${fail} of ${pass + fail} checks failed`);
  for (const label of failures) console.error(`  ✗ ${label}`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('applicant-submit-gateway proof crashed', err);
  process.exit(1);
});
