// ══════════════════════════════════════════════════════════════════
// KAFKAJS TIMER-PATCH GUARD PROOF (zero infrastructure)
//
// The kafkajs@2.2.4 idle-timer fix is carried as a pnpm patch
// (patches/kafkajs@2.2.4.patch + pnpm.patchedDependencies in the root
// package.json). Upstream RequestQueue.scheduleCheckPendingRequests()
// computes `throttledUntil - Date.now()` BEFORE checking whether
// anything is pending; with throttledUntil at its initial -1 that is a
// large negative number, which Node clamps to a 1 ms timeout whose
// callback re-arms it — a permanent ~900 no-op wakeups/sec on every
// broker connection that has ever completed a request. The patch adds
// an early return when nothing is pending and no throttle is active.
//
// WHY THIS PROOF EXISTS: a patch with no proof guarding it is a patch
// that quietly disappears. Nothing else in the gate would notice a
// `pnpm install` or dependency bump that dropped it — the symptom the
// patch fixes is a stderr PROCESS WARNING that exits 0, so a green
// gate cannot tell warned from unwarned. This proof makes the patch's
// presence (and its riskiest branch) a first-class, zero-infra gate
// check instead.
//
// It drives the REAL RequestQueue class — the exact copy this
// workspace resolves, printed below so a failure names the copy that
// answered — with no broker, no socket and no mocks of kafkajs
// internals:
//
//   A) ACTIVE client-side throttle, empty queue → the early return
//      must NOT fire: the ~500 ms throttle timer must still be armed,
//      or a throttled connection would never be re-checked. This is
//      the one branch where the patch could have been a real bug (a
//      dropped wakeup = a silently stalled consumer).
//   B) EXPIRED throttle, empty queue → nothing may be armed. This is
//      the fix itself: UNPATCHED kafkajs arms exactly one timer here
//      with a large negative delay (the ~1 kHz busy loop), so this
//      check fails loudly if the patch is ever dropped. That failure
//      is the feature.
//
//   Run (repo root, no infrastructure needed):
//   npx tsx packages/shared-events/selfcheck/verify-kafka-timer-patch.ts
// ══════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module';

const REQUEST_QUEUE_MODULE = 'kafkajs/src/network/requestQueue';

// kafkajs ships no types for this internal module; it is a plain class.
// The structural type below is exactly the surface this proof touches.
interface GuardedRequestQueue {
  throttledUntil: number;
  throttleCheckTimeoutId: NodeJS.Timeout | null;
  pending: unknown[];
  scheduleCheckPendingRequests: () => void;
  destroy: () => void;
}
type RequestQueueConstructor = new (options: {
  maxInFlightRequests: number | null;
  instrumentationEmitter: null;
  requestTimeout: number;
  enforceRequestTimeout: boolean;
  clientId: string;
  broker: string;
  logger: Record<string, unknown>;
  isConnected: () => boolean;
}) => GuardedRequestQueue;

const require = createRequire(import.meta.url);

let resolvedFrom: string;
let RequestQueue: RequestQueueConstructor;
try {
  resolvedFrom = require.resolve(REQUEST_QUEUE_MODULE);
  RequestQueue = require(REQUEST_QUEUE_MODULE) as RequestQueueConstructor;
} catch (error) {
  console.error(
    `✗ cannot load ${REQUEST_QUEUE_MODULE} — kafkajs layout changed? ${String(error)}`,
  );
  process.exit(1);
}

const noop = (): void => {};
const logger: Record<string, unknown> = {
  debug: noop,
  warn: noop,
  error: noop,
  info: noop,
  namespace: (): Record<string, unknown> => logger,
};

const makeQueue = (): GuardedRequestQueue =>
  new RequestQueue({
    maxInFlightRequests: null,
    instrumentationEmitter: null,
    requestTimeout: 30000,
    enforceRequestTimeout: false,
    clientId: 'timer-patch-proof',
    broker: 'proof:9092',
    logger,
    isConnected: () => true,
  });

// Record every timer delay ASKED of the event loop (before Node's
// negative-clamping), and clamp the real call at 0 so an unpatched
// negative delay can never spin this proof process while we observe it.
const realSetTimeout = globalThis.setTimeout;
const asked: number[] = [];
globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
  asked.push(timeout ?? 0);
  return realSetTimeout(handler, Math.max(timeout ?? 0, 0), ...(rest as never[]));
}) as unknown as typeof globalThis.setTimeout;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m  ✓ ${label}\u001b[0m`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`\u001b[0;31m  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`);
  }
}

try {
  console.log(`\n\u001b[1;36m══ kafkajs timer patch guard (zero infrastructure)\u001b[0m`);
  console.log(`  module under test: ${resolvedFrom}`);

  // ── A: active throttle, empty queue → MUST still arm ──────────────
  console.log('\n\u001b[1;36m══ A: an active throttle still arms its re-check timer\u001b[0m');
  {
    const queue = makeQueue();
    const askedBefore = asked.length;
    queue.throttledUntil = Date.now() + 500; // a broker throttled us for 500 ms
    queue.scheduleCheckPendingRequests();
    const armed = asked.length - askedBefore;
    const delay = asked[asked.length - 1];
    queue.destroy(); // clears the armed timer before it can fire

    check('exactly one timer armed for the active throttle', armed === 1, `armed ${armed}`);
    check(
      'throttle timer armed at the throttle horizon (~500 ms)',
      armed === 1 && delay !== undefined && delay > 400 && delay <= 500,
      armed === 1 ? `delay ${String(delay)} ms` : 'no delay to inspect',
    );
  }

  // ── B: expired throttle, empty queue → MUST NOT arm ───────────────
  console.log('\n\u001b[1;36m══ B: an idle queue with no active throttle arms nothing\u001b[0m');
  {
    const queue = makeQueue();
    const askedBefore = asked.length;
    queue.throttledUntil = Date.now() - 500; // throttle long expired
    queue.scheduleCheckPendingRequests();
    const armed = asked.length - askedBefore;
    queue.destroy();

    check(
      'no timer armed (pending=0, throttle expired)',
      armed === 0,
      `armed ${armed}${armed > 0 ? ` with delay ${String(asked[asked.length - 1])} ms — the unpatched kafkajs busy-loop bug; the pnpm patch is not applied to the install this proof resolved` : ''}`,
    );
  }

  // ── Global: no negative delay may ever be requested ───────────────
  console.log(`\n\u001b[1;36m══ No negative setTimeout delay was requested at any point\u001b[0m`);
  {
    const negative = asked.find((d) => d < 0);
    check(
      'zero negative timer delays requested',
      negative === undefined,
      negative === undefined ? undefined : `asked for ${String(negative)} ms — Node would clamp to 1 ms (TimeoutNegativeWarning on Node >= 23)`,
    );
  }
} finally {
  globalThis.setTimeout = realSetTimeout;
}

console.log('');
if (fail === 0) {
  console.log(`\u001b[1;32mKAFKAJS TIMER PATCH GREEN — ${pass} checks, patch guarded ✓\u001b[0m`);
  process.exit(0);
} else {
  console.error(`\u001b[1;31mKAFKAJS TIMER PATCH RED — ${fail} failed:\u001b[0m`);
  for (const f of failures) console.error(`\u001b[0;31m  ✗ ${f}\u001b[0m`);
  process.exit(1);
}
