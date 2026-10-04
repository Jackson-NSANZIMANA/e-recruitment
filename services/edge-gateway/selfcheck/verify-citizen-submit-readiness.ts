// Citizen-facing submission readiness gate (ADR-027 follow-up).
//
// The application-service contract is idempotent, but the browser cannot use
// that contract until the edge adds a narrowly allowlisted submit operation,
// forwards only a validated Idempotency-Key, and preserves the replay header in
// both its typed upstream result and browser response. Keep the release signal
// BLOCKED until a real browser-boundary proof replaces this gate.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM } from '../src/domain/upstream-operations.js';

const EDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(EDGE_ROOT, '..', '..');
const readiness = JSON.parse(
  readFileSync(join(EDGE_ROOT, 'citizen-submit-readiness.json'), 'utf8'),
) as {
  readonly capability: string;
  readonly status: string;
  readonly complete: boolean;
  readonly blockingItems: readonly string[];
  readonly followUp: string;
};
const adr = readFileSync(
  join(REPO_ROOT, 'docs/architecture/adrs/ADR-027-submission-integrity-and-idempotency.md'),
  'utf8',
);

const failures: string[] = [];
function require(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const operations = Object.values(UPSTREAM);
require(readiness.capability === 'citizen-facing-application-submission-integrity', 'wrong capability');
require(readiness.status === 'BLOCKED', 'status must remain BLOCKED until the edge implementation and proof land');
require(readiness.complete === false, 'complete must be false');
require(readiness.blockingItems.length === 4, 'all four concrete blockers must be reported');
require(
  !operations.some((operation) => operation.method === 'POST' && operation.path === '/v1/applications'),
  'readiness says BLOCKED but an edge submit operation now exists; implement the header contract and browser proof, then replace this gate',
);
require(adr.includes('Edge-tier passthrough of `Idempotency-Key`'), 'ADR follow-up is missing');
require(adr.includes('Idempotency-Replayed: true'), 'ADR must retain the response-header blocker');

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(`FRONT-DOOR READINESS: ${readiness.status}`);
for (const blocker of readiness.blockingItems) console.log(`  • ${blocker}`);
console.log(`Follow-up: ${readiness.followUp}`);
