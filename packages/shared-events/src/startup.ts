// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Bounded service startup
//
// THE DEFECT THIS EXISTS TO PREVENT, STATED PLAINLY: a service that hangs
// during bootstrap never binds its socket, so it never answers /health or
// /ready, so scripts/verify-dev-boot.sh waits out its ENTIRE deadline and
// then reports 'never answered /ready or /health on :PORT'. That sentence
// names a SYMPTOM shared by every possible cause — a broker that will not
// hand out metadata, a DNS lookup into a black hole, a consumer-group
// rebalance that never settles — and distinguishes between none of them.
//
// TWO HALVES, AND NEITHER WORKS ALONE:
//
//   withStartupTimeout()  turns an unbounded hang into a bounded, LOUD
//                         failure. Without it the process waits forever and
//                         the proof waits with it.
//   logStartupPhase()     emits the marker that names the step. Without it a
//                         bounded failure is still an anonymous one — you
//                         learn the service died, not where.
//
// The bound is deliberately generous (30s). It is not a latency budget or a
// health check; it is the line past which 'slow' has become 'stuck'. Kafka
// broker discovery on a cold CI runner alongside Postgres, MinIO, ClamAV and
// four G2G mocks legitimately takes seconds. It does not take thirty.
//
// A TIMED-OUT PROMISE IS NOT A CANCELLED ONE. Promise.race abandons the
// loser, it does not stop it — kafkajs keeps retrying underneath. Every
// caller must therefore treat a StartupTimeoutError as FATAL and exit,
// which is exactly what each service's main().catch() already does. Do not
// 'recover' from one and keep serving: the process would answer /ready while
// holding a transport that may connect minutes later, or never.
// ══════════════════════════════════════════════════════════════════

/**
 * The line past which a bootstrap step has stopped being slow and started
 * being stuck. Overridable per call site, but the default is the contract.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/**
 * Raised when a bootstrap step outlives its bound. Its own type so a caller
 * can tell 'the broker refused us' (a real error, arrives fast) from 'the
 * broker never answered' (this) — the two want different operator responses
 * even though both must end the process.
 */
export class StartupTimeoutError extends Error {
  constructor(
    readonly step: string,
    readonly timeoutMs: number,
  ) {
    super(`startup timed out while ${step} after ${timeoutMs}ms`);
    this.name = 'StartupTimeoutError';
  }
}

/**
 * Bound one bootstrap step.
 *
 * `step` is prose that completes 'startup timed out while ___' — e.g.
 * 'connecting the event bus'. It lands verbatim in the operator-facing error,
 * so write it for the person reading a red CI job at midnight.
 */
export async function withStartupTimeout<T>(
  operation: Promise<T>,
  step: string,
  timeoutMs: number = DEFAULT_STARTUP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StartupTimeoutError(step, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    // Always clear it: a pending timer keeps the event loop alive, which would
    // leave a service that failed for some OTHER reason hanging around for the
    // remainder of the bound instead of exiting now.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Emit a structured startup marker on the SAME line format the services
 * already use, so `pnpm dev`'s interleaved output stays greppable per service.
 *
 * Call it BEFORE the step it names, never after. A marker printed after a
 * step completes tells you what already worked; the whole point is for the
 * LAST line in the log to name the step that did not.
 */
export function logStartupPhase(
  service: string,
  phase: string,
  extra: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ msg: 'startup_phase', service, phase, ...extra }));
}
