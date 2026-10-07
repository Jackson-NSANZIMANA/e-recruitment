// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Dead-letter policy (poison-message containment)
//
// THE DEFECT THIS EXISTS TO PREVENT: kafkajs treats a throw from eachMessage
// as 'try again'. It restarts the consumer and redelivers the SAME offset —
// forever. One malformed payload, or one event a handler deterministically
// cannot process, therefore halts its whole partition: every applicant whose
// key hashes there stops advancing, while /health and /ready stay green. On a
// national pipeline keyed by applicantId that is not one stuck citizen, it is
// one-sixth of a vetting topic.
//
// The policy, in order:
//   1. UNDECODABLE  — bytes that are not a valid USRP event can never succeed.
//                     Dead-lettered immediately; no retry.
//   2. NON_RETRYABLE — the handler threw NonRetryableEventError: it has
//                     decided this event will never be processable.
//   3. HANDLER_FAILED — any other throw is presumed TRANSIENT (database blip,
//                     upstream timeout) and retried in-process with capped
//                     exponential backoff. Only after maxHandlerAttempts is it
//                     dead-lettered.
//
// DEAD-LETTERED OR REDELIVERED, NEVER DROPPED: if the dead-letter write itself
// fails, the bus rethrows and kafkajs redelivers. An offset is committed past
// an event only once that event is either handled or durably parked.
//
// Dead-lettering is an ALARM, not a disposal: every one logs
// `event_dead_lettered` at error level, and the original bytes are preserved
// unmodified so scripts/replay-dead-letters.ts can re-publish them byte-exact.
// ══════════════════════════════════════════════════════════════════

/** One shared parking topic. Headers say which consumer group failed. */
export const DEAD_LETTER_TOPIC = 'events.dead-letter' as const;

/** Header names carried by every dead-lettered message. */
export const DLQ_HEADERS = {
  REASON: 'x-usrp-dlq-reason',
  GROUP: 'x-usrp-dlq-group',
  SOURCE_TOPIC: 'x-usrp-dlq-source-topic',
  SOURCE_PARTITION: 'x-usrp-dlq-source-partition',
  SOURCE_OFFSET: 'x-usrp-dlq-source-offset',
  ATTEMPTS: 'x-usrp-dlq-attempts',
  ERROR: 'x-usrp-dlq-error',
  EVENT_ID: 'x-usrp-dlq-event-id',
  DEAD_LETTERED_AT: 'x-usrp-dlq-at',
} as const;

export type DeadLetterReason = 'UNDECODABLE' | 'NON_RETRYABLE' | 'HANDLER_FAILED';

/**
 * Throw from an event handler to declare the event PERMANENTLY unprocessable
 * (e.g. it references an aggregate whose schema it can never satisfy). It is
 * dead-lettered on the first attempt instead of burning the retry budget.
 *
 * Do NOT use it for infrastructure faults. A database that is down now will be
 * up later; that is exactly what the retry budget is for.
 */
export class NonRetryableEventError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NonRetryableEventError';
  }
}

export interface DeadLetterPolicy {
  /** Where parked messages go. Must exist: broker auto-create is disabled. */
  readonly topic: string;
  /** Total handler invocations (first try included) before dead-lettering. */
  readonly maxHandlerAttempts: number;
  /** Backoff before retry n is base * 2^(n-1), capped at maxBackoffMs. */
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

/**
 * Six attempts over ~15.5s (0.5 + 1 + 2 + 4 + 8). Long enough to ride out a
 * connection-pool blip or a database failover; short enough that a genuinely
 * broken event does not hold a partition hostage for minutes.
 */
export const DEFAULT_DEAD_LETTER_POLICY: DeadLetterPolicy = {
  topic: DEAD_LETTER_TOPIC,
  maxHandlerAttempts: 6,
  baseBackoffMs: 500,
  maxBackoffMs: 15_000,
};

/** Resolve and validate a policy. Misconfiguration fails at construction. */
export function resolveDeadLetterPolicy(overrides: Partial<DeadLetterPolicy> = {}): DeadLetterPolicy {
  const policy: DeadLetterPolicy = { ...DEFAULT_DEAD_LETTER_POLICY, ...overrides };
  if (!Number.isInteger(policy.maxHandlerAttempts) || policy.maxHandlerAttempts < 1) {
    throw new RangeError(`deadLetter.maxHandlerAttempts must be an integer >= 1, got ${String(policy.maxHandlerAttempts)}`);
  }
  if (!(policy.baseBackoffMs >= 0) || !(policy.maxBackoffMs >= policy.baseBackoffMs)) {
    throw new RangeError('deadLetter backoff must satisfy 0 <= baseBackoffMs <= maxBackoffMs');
  }
  if (policy.topic.trim() === '') {
    throw new RangeError('deadLetter.topic must be a non-empty topic name');
  }
  return policy;
}

/** Delay before the retry that follows failed attempt `attempt` (1-based). */
export function backoffMs(policy: DeadLetterPolicy, attempt: number): number {
  return Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** (attempt - 1));
}

/**
 * Operator-facing error text: name + message only, truncated. Never a stack
 * (paths and internals), never `cause` chains (driver errors can carry row
 * values). Lands in a Kafka header and a log line, so it must stay short.
 */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.length > 512 ? `${raw.slice(0, 509)}...` : raw;
}
