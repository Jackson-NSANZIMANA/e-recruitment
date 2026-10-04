// Citizen-facing submission readiness gate (ADR-027 follow-up, now LANDED).
//
// This gate was born BLOCKED: it held the release signal while the edge had
// no submit operation, forwarded no Idempotency-Key, and dropped
// Idempotency-Replayed. The implementation has since landed, and this file
// changed with it — from a promise-to-stay-blocked into a structural
// verification that every load-bearing piece of the front door EXISTS and
// STAYS WIRED:
//
//   • the identity-service submit bridge (typed port + HTTP adapter + route);
//   • the edge operation (exact method/path/session/CSRF/retry posture) and
//     its upstream catalogue entry (the edge calls the BRIDGE, never
//     application-service's /v1/applications directly);
//   • the NARROW idempotency plumbing: a typed `idempotencyKey` field in, an
//     allowlisted `Idempotency-Replayed` boolean out — no header forwarding;
//   • CORS exposure of Idempotency-Replayed (a browser cannot read an
//     unlisted response header);
//   • the applicant-session submission rate limit and its shared store;
//   • the OpenAPI document describing the operation;
//   • every proof that gates this capability existing AND being registered
//     in the quality gate.
//
// It remains ZERO-INFRASTRUCTURE by design (it runs at the front of the
// gate), so it verifies STRUCTURE, not behaviour: the executable proofs it
// references are the behaviour. citizen-submit-readiness.json records which
// proofs this signal depends on; if any of them is skipped because
// infrastructure is unavailable, the release signal is BLOCKED regardless of
// what this file says — a skipped proof is not a passing one.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EDGE_OPERATIONS,
  UPSTREAM,
} from '../src/index.js';

const EDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(EDGE_ROOT, '..', '..');
const failures: string[] = [];

function require(condition: boolean, message: string): void {
  if (condition) return;
  failures.push(message);
}

/** Read a repo file relative to the root; empty string when missing. */
function read(rel: string): string {
  try {
    return readFileSync(join(REPO_ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

// ── 1. The readiness manifest itself ───────────────────────────────────
const readiness = JSON.parse(read('services/edge-gateway/citizen-submit-readiness.json')) as {
  readonly capability: string;
  readonly status: string;
  readonly complete: boolean;
  readonly verifiedBy: readonly { readonly id: string; readonly proof: string }[];
  readonly gate: string;
};
require(readiness.capability === 'citizen-facing-application-submission-integrity', 'wrong capability');
require(readiness.status === 'READY', 'status must be READY — or BLOCKED, honestly, if a listed proof cannot run');
require(readiness.complete === true, 'complete must be true');
require(
  readiness.verifiedBy.length === 6,
  'the six gating proofs (bridge, edge contract, edge socket, rate-limit store, submission integrity, walk-in outbox) must all be listed',
);
require(
  readiness.gate === 'services/edge-gateway/selfcheck/verify-citizen-submit-readiness.ts',
  'the manifest must point at this gate',
);

// ── 2. The identity-service submit bridge ──────────────────────────────
const bridgePort = read('services/identity-service/src/ports/applications-gateway.ts');
require(bridgePort.includes('submitForApplicant'), 'bridge port: submitForApplicant is missing');
require(bridgePort.includes('ApplicantSubmitResult'), 'bridge port: the typed result is missing');
require(
  bridgePort.includes("'KEY_REUSED'") && bridgePort.includes("'REPLAYED'"),
  'bridge port: the integrity answers must be typed',
);
const bridgeAdapter = read('services/identity-service/src/adapters/applications.http-gateway.ts');
require(
  bridgeAdapter.includes('idempotency-key') && bridgeAdapter.includes('/v1/applications'),
  'bridge adapter: must call POST /v1/applications with the Idempotency-Key header',
);
require(
  bridgeAdapter.includes("'WEB'"),
  'bridge adapter: the browser channel must be pinned server-side',
);
const bridgeRoute = read('services/identity-service/src/adapters/http/applicant-auth.controller.ts');
require(
  bridgeRoute.includes('IDEMPOTENCY_REPLAYED_HEADER') && bridgeRoute.includes('INVALID_IDEMPOTENCY_KEY'),
  'bridge route: the key/replay header handling is missing',
);
require(
  bridgeRoute.includes('Field "applicantId" is derived from the session'),
  'bridge route: a body applicantId must be refused, never trusted',
);

// ── 3. The edge operation ──────────────────────────────────────────────
const submit = EDGE_OPERATIONS.submitMyApplication;
require(submit !== undefined, 'edge registry: submitMyApplication is missing');
if (submit !== undefined) {
  require(submit.method === 'POST' && submit.path === '/edge/v1/me/applications', 'edge registry: wrong method/path');
  require(submit.session === 'applicant', 'edge registry: submit must be applicant-session');
  require(submit.csrf === true, 'edge registry: submit must enforce CSRF');
  require(submit.retryOnG2G === false, 'edge registry: the edge must never retry the write');
  require(submit.composition === 'single' && submit.upstream.length === 1, 'edge registry: submit must front exactly one upstream');
}
const mySubmit = UPSTREAM.mySubmit;
require(mySubmit !== undefined, 'upstream catalogue: mySubmit is missing');
if (mySubmit !== undefined) {
  require(
    mySubmit.service === 'identity' && mySubmit.method === 'POST' && mySubmit.path === '/v1/applicants/me/applications' && mySubmit.credential === 'applicant-opaque',
    'upstream catalogue: submit must front the identity bridge with the applicant session',
  );
}
// The edge must NOT hold a direct route to application-service's front door —
// the bridge is the only path, because it is where the subject is re-derived
// and the system token applied.
require(
  !Object.values(UPSTREAM).some((operation) => operation.service === 'application' && operation.method === 'POST' && operation.path === '/v1/applications'),
  'upstream catalogue: the edge must reach the front door through the identity bridge, never directly',
);

// ── 4. The narrow idempotency plumbing ─────────────────────────────────
const upstreamPort = read('services/edge-gateway/src/ports/upstream-gateway.ts');
require(
  upstreamPort.includes('readonly idempotencyKey?: string'),
  'upstream port: the typed idempotencyKey field is missing',
);
require(
  upstreamPort.includes('readonly replayed?: boolean'),
  'upstream port: the allowlisted replayed flag is missing',
);
require(
  !upstreamPort.includes('headers?:') && !upstreamPort.includes('readonly headers'),
  'upstream port: there must be NO generic request-header forwarding',
);
const upstreamAdapter = read('services/edge-gateway/src/adapters/upstream.http-gateway.ts');
require(
  upstreamAdapter.includes("headers['idempotency-key'] = input.idempotencyKey"),
  'upstream adapter: the key must be emitted as the one narrow typed header',
);
require(
  upstreamAdapter.includes("response.headers.get('idempotency-replayed')"),
  'upstream adapter: the replay flag must be read from the response',
);

// ── 5. CORS exposure + the edge controller ─────────────────────────────
const composition = read('services/edge-gateway/src/index.ts');
require(
  composition.includes("'Idempotency-Replayed'") && composition.includes('exposedHeaders'),
  'CORS: Idempotency-Replayed must be exposed or the browser cannot read it',
);
require(
  composition.includes('idempotency-key') && composition.includes('allowedHeaders'),
  'CORS: the browser must be allowed to SEND Idempotency-Key',
);
const citizenController = read('services/edge-gateway/src/adapters/http/citizen.controller.ts');
require(
  citizenController.includes('submitMyApplicationHandler') &&
    citizenController.includes('EDGE_IDEMPOTENT_REPLAY') &&
    citizenController.includes('EDGE_IDEMPOTENCY_KEY_REUSED'),
  'edge controller: the submit handler and its audit actions are missing',
);
require(
  citizenController.includes('sessionBucketKey') && citizenController.includes('applicantSubmitPerMinute'),
  'edge controller: the applicant-session submission rate limit is not wired',
);

// ── 6. The shared rate-limit store + the production guard ─────────────
const rateLimitStore = read('services/edge-gateway/src/adapters/rate-limiter.pg.ts');
require(
  rateLimitStore.includes("store = 'postgres'") && rateLimitStore.includes('ON CONFLICT'),
  'rate limit: the shared Postgres store (atomic upsert) is missing',
);
require(
  composition.includes('assertRateLimitStoreAllowed'),
  'rate limit: the production boot guard must be exported',
);
const rateLimitMigration = read('packages/shared-database/src/rls/0024_edge_rate_limit_buckets.sql');
require(
  rateLimitMigration.includes('edge_rate_limit_buckets') && rateLimitMigration.includes('usrp_edge_gateway'),
  'rate limit: the rls/0024 migration is missing or not edge-role-scoped',
);
const bootstrap = read('scripts/bootstrap-db.sh');
require(
  bootstrap.includes('0024_edge_rate_limit_buckets.sql'),
  'bootstrap: the rate-limit migration must run on every bootstrap',
);

// ── 7. The OpenAPI document ────────────────────────────────────────────
const openapi = read('services/edge-gateway/openapi/edge-v1.yaml');
require(openapi.includes('operationId: submitMyApplication'), 'OpenAPI: the submit operation is not described');
require(openapi.includes('Idempotency-Replayed'), 'OpenAPI: the replay header is not documented');
require(openapi.includes('KEY_REUSED'), 'OpenAPI: the key-reuse answer is not documented');

// ── 8. Every gating proof exists and is registered ─────────────────────
const selfcheckRunner = read('scripts/run-selfchecks.sh');
for (const { id, proof } of readiness.verifiedBy) {
  const source = read(proof);
  require(source.length > 0, `proof ${id}: ${proof} does not exist`);
  require(
    selfcheckRunner.includes(proof),
    `proof ${id}: ${proof} is not registered in scripts/run-selfchecks.sh — an unregistered proof never runs`,
  );
}

// ── 9. The ADR records the follow-up as delivered ─────────────────────
const adr = read('docs/architecture/adrs/ADR-027-submission-integrity-and-idempotency.md');
require(
  adr.includes('Edge-tier passthrough of `Idempotency-Key`'),
  'ADR: the follow-up section must keep its history',
);
require(
  adr.includes('delivered through the identity-service submit bridge') ||
    adr.includes('submitMyApplication'),
  'ADR: the follow-up must be recorded as delivered, not left as a dangling "not done here"',
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log('FRONT-DOOR READINESS: READY');
console.log('  ✓ identity submit bridge (POST /v1/applicants/me/applications)');
console.log('  ✓ edge operation (POST /edge/v1/me/applications, applicant session, CSRF, no retry)');
console.log('  ✓ Idempotency-Key in (typed field), Idempotency-Replayed out (allowlisted flag + CORS)');
console.log('  ✓ shared rate-limit store + production memory refusal');
for (const { id, proof } of readiness.verifiedBy) console.log(`  • gated by ${id}: ${proof}`);
console.log('  The behaviour itself is proven by the registered proofs above (scripts/run-selfchecks.sh).');
