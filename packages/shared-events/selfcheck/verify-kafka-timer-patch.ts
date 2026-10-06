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
// internals. Five checks, covering every row of the patch's spec:
//
//   A) ACTIVE client-side throttle (500 ms), empty queue → the early
//      return must NOT fire: the ~500 ms throttle timer must still be
//      armed, or a throttled connection would never be re-checked.
//      This is the one branch where the patch could have been a real
//      bug (a dropped wakeup = a silently stalled consumer).
//   B) EXPIRED throttle, empty queue → nothing may be armed. This is
//      the fix itself: UNPATCHED kafkajs arms exactly one timer here
//      with a large negative delay (the ~1 kHz busy loop), so this
//      check fails loudly if the patch is ever dropped.
//   C) NEVER throttled (throttledUntil still at its initial -1),
//      empty queue → nothing may be armed. Same branch as B, but this
//      is the exact production scenario behind every one of the eight
//      TimeoutNegativeWarning lines: an idle connection that has sent
//      requests and was never throttled.
//   D) SATURATED queue drains: 3 requests against maxInFlight=1,
//      fulfilled in order → all sent, all resolved, pending 0,
//      inflight 0, and pending work WAS scheduled while queued (the
//      10 ms clamp) — the safety net push() re-arming the timer.
//   E) POST-DRAIN IDLE: after D, zero checkPendingRequests wakeups in
//      a 300 ms sample. This encodes the symptom BEHAVIOURLY — it
//      catches the busy loop on any Node version, including Node 22
//      where the warning never prints (unpatched: ~270 wakeups per
//      300 ms; patched: 0, deterministically, because no timer is
//      armed to wake).
//
//   Run (repo root, no infrastructure needed):
//   npx tsx packages/shared-events/selfcheck/verify-kafka-timer-patch.ts
// ══════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module';

const REQUEST_QUEUE_MODULE = 'kafkajs/src/network/requestQueue';

// kafkajs ships no types for this internal module; it is a plain class.
// The structural type below is exactly the surface this proof touches.
interface ProofEntry {
  apiKey: number;
  apiName: string;
  apiVersion: number;
  correlationId: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
interface GuardedRequestQueue {
  throttledUntil: number;
  throttleCheckTimeoutId: NodeJS.Timeout | null;
  pending: unknown[];
  inflight: Map<number, unknown>;
  scheduleCheckPendingRequests: () => void;
  checkPendingRequests: () => void;
  push: (request: {
    entry: ProofEntry;
    expectResponse: boolean;
    sendRequest: () => void;
  }) => void;
  fulfillRequest: (response: {
    correlationId: number;
    payload: null;
    size: number;
  }) => void;
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

const makeQueue = (maxInFlightRequests: number | null): GuardedRequestQueue =>
  new RequestQueue({
    maxInFlightRequests,
    instrumentationEmitter: null,
    requestTimeout: 30000,
    enforceRequestTimeout: false,
    clientId: 'timer-patch-proof',
    broker: 'proof:9092',
    logger,
    isConnected: () => true,
  });

let correlation = 0;
function makeEntry(stats: { sent: number; resolved: number; rejected: number }): ProofEntry {
  correlation += 1;
  return {
    apiKey: 3,
    apiName: 'Metadata',
    apiVersion: 1,
    correlationId: correlation,
    resolve: () => {
      stats.resolved += 1;
    },
    reject: (error: unknown) => {
      stats.rejected += 1;
    },
  };
}

// Record every timer delay ASKED of the event loop (before Node's
// negative-clamping), and clamp the real call at 0 so an unpatched
// negative delay can never spin this proof process while we observe it.
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => realSetTimeout(resolve, ms));
const asked: number[] = [];
globalThis.setTimeout = ((
  handler: TimerHandler,
  timeout?: number,
  ...rest: unknown[]
) => {
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
    const queue = makeQueue(null);
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
  console.log('\n\u001b[1;36m══ B: an idle queue with an expired throttle arms nothing\u001b[0m');
  {
    const queue = makeQueue(null);
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

  // ── C: never throttled, empty queue → MUST NOT arm ────────────────
  // throttledUntil is still at its constructor initial -1: the exact
  // state of every idle connection that has ever completed a request —
  // the state that produced all eight TimeoutNegativeWarning lines.
  console.log('\n\u001b[1;36m══ C: a never-throttled idle queue arms nothing (the warning scenario)\u001b[0m');
  {
    const queue = makeQueue(null);
    const askedBefore = asked.length;
    queue.scheduleCheckPendingRequests();
    const armed = asked.length - askedBefore;
    queue.destroy();

    check(
      'no timer armed (pending=0, throttledUntil still -1)',
      armed === 0 && queue.throttledUntil === -1,
      `armed ${armed}, throttledUntil ${String(queue.throttledUntil)}`,
    );
  }

  // ── D: saturated queue drains ─────────────────────────────────────
  console.log('\n\u001b[1;36m══ D: a saturated queue still drains (push() re-arms the timer)\u001b[0m');
  {
    const queue = makeQueue(1); // maxInFlightRequests: 1
    const stats = { sent: 0, resolved: 0, rejected: 0 };
    const askedBefore = asked.length;

    const entries = [0, 1, 2].map(() => makeEntry(stats));
    for (const entry of entries) {
      queue.push({
        entry,
        expectResponse: true,
        sendRequest: () => {
          stats.sent += 1;
        },
      });
    }
    // request 1 is in flight immediately; 2 are pending behind maxInFlight=1,
    // and the pending>0 path schedules them at the 10 ms clamp.
    for (const entry of entries) {
      await sleep(25); // let the clamp timer fire as it would in production
      queue.fulfillRequest({ correlationId: entry.correlationId, payload: null, size: 0 });
    }
    await sleep(60);

    const scheduledWhilePending = asked.length - askedBefore;
    check(
      'all requests sent and resolved, queue empty',
      stats.sent === 3 && stats.resolved === 3 && stats.rejected === 0
        && queue.pending.length === 0 && queue.inflight.size === 0,
      `sent ${String(stats.sent)}, resolved ${String(stats.resolved)}, rejected ${String(stats.rejected)}, pending ${String(queue.pending.length)}, inflight ${String(queue.inflight.size)}`,
    );
    check(
      'pending work was scheduled while queued (10 ms clamp path alive)',
      scheduledWhilePending > 0,
      `${String(scheduledWhilePending)} timers scheduled`,
    );

    // ── E: post-drain idle → zero wakeups ───────────────────────────
    console.log('\n\u001b[1;36m══ E: a drained idle queue performs zero wakeups\u001b[0m');
    let wakeups = 0;
    const origCheck = queue.checkPendingRequests;
    queue.checkPendingRequests = function (this: GuardedRequestQueue, ...args: []) {
      wakeups += 1;
      return origCheck.apply(this, args);
    };
    await sleep(300); // ~270 no-op wakeups here on unpatched kafkajs
    check(
      'zero checkPendingRequests wakeups in a 300 ms idle sample',
      wakeups === 0,
      `${String(wakeups)} wakeups in 300 ms — the busy loop; the pnpm patch is not applied to the install this proof resolved`,
    );
    queue.destroy();
  }

  // ── Global: no negative delay may ever be requested ───────────────
  console.log('\n\u001b[1;36m══ No negative setTimeout delay was requested at any point\u001b[0m');
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
