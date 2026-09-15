// ══════════════════════════════════════════════════════════════════
// edge-gateway — CONTRACT DRIFT PROOF (zero infrastructure)
//
// This is the proof whose absence caused the incident this whole tier exists to
// fix. An OpenAPI document described four BFF services that did not exist, and
// nothing compared the document to a runtime, so it was read as fact for a
// month. Documentation cannot be trusted to describe a system; only a check that
// fails can.
//
// It asserts agreement in BOTH DIRECTIONS, which is the part that matters:
//
//   registry → document   every mounted operation is described.
//   document → registry   every described operation is MOUNTED. This direction
//                         is the one that catches a promise nothing serves.
//
// Plus the structural invariants that must not regress silently: no path
// templating, no PATCH/DELETE, no bearer scheme, no nationalIdHash, no agency in
// any request, CSRF on every unsafe operation, and no state-changing write
// marked retryable.
//
// It opens no socket and touches no database, so it runs beside the production
// boot guard at the very front of the gate.
// ══════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROKERED_SERVICE_INTERNAL,
  EDGE_OPERATIONS,
  EDGE_OPERATION_IDS,
  PUBLIC_ALLOWLIST,
  UPSTREAM,
  createEdgeGateway,
  edgeOperation,
  type EdgeOperationId,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(HERE, '..', 'openapi', 'edge-v1.yaml');

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m  \u2713 ${label}\u001b[0m`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`\u001b[0;31m  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`);
  }
}

function section(title: string): void {
  console.log(`\n\u001b[1;36m══ ${title}\u001b[0m`);
}

const spec = readFileSync(OPENAPI_PATH, 'utf8');
const specLines = spec.split('\n');

// ── 1. Registry → document ───────────────────────────────────────
section('Every mounted operation is described in the OpenAPI document');

for (const id of EDGE_OPERATION_IDS) {
  const operation = edgeOperation(id);
  check(
    `${id}: path ${operation.path} present`,
    spec.includes(`\n  ${operation.path}:`),
    'the document does not declare this exact path at the paths root',
  );
  check(`${id}: operationId declared`, spec.includes(`operationId: ${id}`));
  check(
    `${id}: x-usrp-session: ${operation.session}`,
    spec.includes(`operationId: ${id}`) &&
      sessionMarkerFor(id) === operation.session,
    `document says ${String(sessionMarkerFor(id))}, registry says ${operation.session}`,
  );
}

/**
 * Read the `x-usrp-session` marker that follows an operationId.
 *
 * A deliberate 40-line scan rather than a YAML dependency: shared packages hold
 * a zero-runtime-dependency line, and a parser in the supply chain to read one
 * marker per operation is a poor trade for a repo whose whole posture is
 * "fewer things that can be compromised".
 */
function sessionMarkerFor(id: string): string | undefined {
  const start = specLines.findIndex((line) => line.trim() === `operationId: ${id}`);
  if (start === -1) return undefined;
  for (let i = start; i < Math.min(start + 25, specLines.length); i += 1) {
    const line = specLines[i];
    if (line === undefined) break;
    const match = /^\s*x-usrp-session:\s*(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined) return match[1];
    // Stop at the next operationId so a missing marker never borrows its
    // neighbour's — that would turn a real gap into a false pass.
    if (i > start && /^\s*operationId:/.test(line)) break;
  }
  return undefined;
}

// ── 2. Document → registry (the direction that catches a lie) ─────────
section('Every described operation is actually MOUNTED');

const declaredIds = [...spec.matchAll(/^\s*operationId:\s*(\S+)\s*$/gm)].map((m) => m[1] ?? '');
// The two transport-reserved probes are served by shared-http itself, not by a
// registry entry — they exist in the document because a client must know they
// are there.
const TRANSPORT_OPERATIONS = new Set(['edgeHealth', 'edgeReady']);
const registryIds = new Set<string>(EDGE_OPERATION_IDS);

for (const declared of declaredIds) {
  if (TRANSPORT_OPERATIONS.has(declared)) continue;
  check(
    `document operationId ${declared} is mounted`,
    registryIds.has(declared),
    'described in the contract but absent from the operation registry — this is the exact defect class ADR-024 exists to prevent',
  );
}
check(
  `document declares ${String(EDGE_OPERATION_IDS.length)} operations plus 2 probes`,
  declaredIds.length === EDGE_OPERATION_IDS.length + TRANSPORT_OPERATIONS.size,
  `found ${String(declaredIds.length)}`,
);

// ── 3. The route table actually mounts them ─────────────────────────
section('The composed route table matches the registry exactly');

// createEdgeGateway is lazy: no socket, no pool. It reads config only.
const gateway = createEdgeGateway();
check(
  'route count equals operation count',
  gateway.routes.length === EDGE_OPERATION_IDS.length,
  `${String(gateway.routes.length)} routes vs ${String(EDGE_OPERATION_IDS.length)} operations`,
);
for (const id of EDGE_OPERATION_IDS) {
  const operation = edgeOperation(id);
  const mounted = gateway.routes.filter(
    (route) => route.path === operation.path && route.method === operation.method,
  );
  check(`${id}: mounted exactly once`, mounted.length === 1, `${String(mounted.length)} matches`);
  check(
    `${id}: body cap ${String(operation.maxBodyBytes)} applied`,
    mounted[0]?.maxBodyBytes === operation.maxBodyBytes,
  );
}

// ── 4. Structural invariants ─────────────────────────────────────
section('Structural invariants of the boundary');

for (const id of EDGE_OPERATION_IDS) {
  const operation = edgeOperation(id);
  check(
    `${id}: path is exact (no templating)`,
    !operation.path.includes('{') && !operation.path.includes(':'),
    'shared-http matches paths EXACTLY (ADR-005) — a templated path 404s for every input',
  );
  check(`${id}: path is under /edge/v1/`, operation.path.startsWith('/edge/v1/'));
  check(
    `${id}: method is GET or POST`,
    operation.method === 'GET' || operation.method === 'POST',
  );
  if (operation.method === 'POST') {
    check(`${id}: CSRF enforced on an unsafe method`, operation.csrf);
  } else {
    check(`${id}: no CSRF on a safe method`, !operation.csrf);
  }
}

check(
  'document declares no PATCH operation',
  !/^\s{4}patch:/m.test(spec),
  'a generic status PATCH is a broken authorization model, not a URL style choice',
);
check('document declares no DELETE operation', !/^\s{4}delete:/m.test(spec));
check(
  'document declares no bearer security scheme',
  !spec.includes('bearerAuth') && !/scheme:\s*bearer/.test(spec),
  'no operation may accept an Authorization header',
);
check(
  'document never names nationalIdHash',
  !spec.includes('nationalIdHash'),
  'a client-computed identity claim over 16 structured digits is forgeable AND reversible',
);
check(
  'no request schema accepts an agency',
  !/^\s*agency:\s*\{\s*\$ref:.*Agency.*\}\s*$/m.test(spec.split('components:')[0] ?? ''),
  'agency is derived from the verified officer session, never accepted as input',
);

// ── 5. Retry disposition ────────────────────────────────────────
section('No state-changing write is marked retryable');

/**
 * The ONE retryable POST, and it is not a state change on an application: it
 * asks for a challenge to be issued. Its own rate limit is what bounds a repeat,
 * and the frontend registry verified it as retryable. Everything else that POSTs
 * writes something a citizen's record must not receive twice.
 */
const RETRYABLE_POSTS: ReadonlySet<EdgeOperationId> = new Set(['requestApplicantOtp']);

for (const id of EDGE_OPERATION_IDS) {
  const operation = edgeOperation(id);
  if (operation.method !== 'POST') continue;
  const expected = RETRYABLE_POSTS.has(id);
  check(
    `${id}: retryOnG2G is ${String(expected)}`,
    operation.retryOnG2G === expected,
    'a retried transition is a double write on a citizen legal record',
  );
}

// ── 6. Upstream catalogue ──────────────────────────────────────
section('Every edge operation maps to approved upstream operations only');

const catalogue = new Set(Object.values(UPSTREAM).map((operation) => operation.id));
for (const id of EDGE_OPERATION_IDS) {
  const operation = edgeOperation(id);
  for (const upstream of operation.upstream) {
    check(
      `${id}: upstream ${upstream.id} is in the approved catalogue`,
      catalogue.has(upstream.id),
    );
    check(
      `${id}: upstream ${upstream.id} path is a /v1/ route`,
      upstream.path.startsWith('/v1/'),
    );
  }
  if (operation.composition === 'single') {
    check(`${id}: exactly one upstream operation`, operation.upstream.length === 1);
  }
  if (operation.composition === 'composed') {
    check(`${id}: more than one upstream`, operation.upstream.length > 1);
    check(
      `${id}: composition reason stated`,
      typeof operation.compositionReason === 'string' && operation.compositionReason.length > 40,
      'a composed operation must say WHY, or one-to-one stops meaning anything',
    );
  }
  if (operation.composition === 'local') {
    check(`${id}: no upstream for a session-local operation`, operation.upstream.length === 0 || id === 'logoutApplicant');
  }
}

// ── 7. The two auditable allowlists ───────────────────────────────
section('The public surface and the brokered exception are exactly as approved');

/**
 * Anything reachable without a session. Growing this list costs a reviewer's
 * signature, which is the entire mechanism — so the proof pins it.
 *
 * readSession and refreshSession are declared anonymous by the frontend registry
 * because the SPA calls them before it knows whether it has a session. Neither
 * can DO anything without one: the probe answers 401 and refresh answers 401.
 * The three that can succeed unauthenticated are the credential doors.
 */
const APPROVED_PUBLIC: readonly EdgeOperationId[] = [
  'readSession',
  'refreshSession',
  'officerLogin',
  'requestApplicantOtp',
  'verifyApplicantOtp',
];

check(
  'the public allowlist is exactly the approved set',
  PUBLIC_ALLOWLIST.length === APPROVED_PUBLIC.length &&
    APPROVED_PUBLIC.every((id) => PUBLIC_ALLOWLIST.includes(id)),
  `registry: ${PUBLIC_ALLOWLIST.join(', ')}`,
);
check(
  'exactly one brokered service-internal upstream',
  BROKERED_SERVICE_INTERNAL.length === 1 && BROKERED_SERVICE_INTERNAL[0] === 'verifyIdentity',
  `found: ${BROKERED_SERVICE_INTERNAL.join(', ')}`,
);
check(
  'only the two logout operations tolerate a missing session',
  EDGE_OPERATION_IDS.filter((id) => edgeOperation(id).idempotentWithoutSession === true).join(
    ',',
  ) === 'officerLogout,logoutApplicant',
);

// ── 8. Field sync is either brokered or excluded, explicitly ───────────
section('Field sync is resolved, not left ambiguous');

const FIELD_SYNC: readonly EdgeOperationId[] = [
  'enrollFieldDevice',
  'syncFieldScores',
  'resolveFieldSyncConflict',
];
for (const id of FIELD_SYNC) {
  const operation = edgeOperation(id);
  check(`${id}: brokered through the edge`, operation.upstream.length === 1);
  check(`${id}: officer session only`, operation.session === 'officer');
  check(`${id}: not automatically retryable`, !operation.retryOnG2G);
}
check(
  'the score batch has a raised body cap and nothing else does',
  EDGE_OPERATION_IDS.filter((id) => edgeOperation(id).maxBodyBytes > 8 * 1_024).join(',') ===
    'syncFieldScores',
);

// ── Summary ──────────────────────────────────────────────────
console.log(`\n\u001b[1m────────────────────────────────────────\u001b[0m`);
if (fail === 0) {
  console.log(`\u001b[1;32mEDGE CONTRACT GREEN — ${String(pass)} checks, no drift ✓\u001b[0m`);
  process.exit(0);
}
console.error(`\u001b[0;31m${String(fail)} of ${String(pass + fail)} checks failed\u001b[0m`);
for (const label of failures) console.error(`  \u001b[0;31m✗ ${label}\u001b[0m`);
process.exit(1);
