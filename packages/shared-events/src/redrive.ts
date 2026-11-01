// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Durable dead-letter re-drive policy (D2, pure)
//
// THE GAP ADR-025 LEFT OPEN. Dead-lettering stopped one bad event from holding a
// partition hostage, which was right. It also made the graveyard permanent:
//
//   • the in-process retry budget is six attempts in ~15.5 s — a window, not a
//     schedule, so an outage longer than that is indistinguishable from a
//     permanent failure;
//   • nothing read the graveyard automatically. The operator tool is stateless:
//     no per-letter record of "already retried", no backoff, no cap — running it
//     after a one-hour outage re-publishes letters that already succeeded.
//
// The result was not a lost event. The event was durable; its STATE was not. A
// clearance certificate whose Irembo lookup met a 429 sat at CRIMINAL_CLEARANCE
// with a PENDING verification row and a checklist claiming "we are verifying" —
// for eleven days, until somebody read the evaluation.
//
// THE POLICY, as one total function over durable state:
//
//   NON_RETRYABLE / UNDECODABLE → never re-driven (the handler or the bytes
//                                 already said no; only a code change helps)
//   a tripped group breaker     → PARK (a deterministically broken handler must
//                                 not turn the deployment into a retry furnace)
//   attempts exhausted          → PARK (never retry forever, never silently)
//   not yet due                 → WAIT  (the ledger's next_attempt_at IS the
//                                 schedule; a Kafka offset cannot schedule)
//   otherwise                   → REDRIVE
//
// The delays are the owner's: 1 m, 5 m, 15 m, 1 h, 3 h, 6 h — six attempts over
// ~10 h, which is what "an overnight upstream outage" means in practice.
//
// Everything here is pure: no clock, no I/O, no Kafka. The service supplies
// `now` and the ledger row. That is what makes the schedule arguable in a test
// file instead of in production.
// ══════════════════════════════════════════════════════════════════

import type { DeadLetterReason } from './dead-letter.js';

/** Where letters go when the schedule gives up. Pre-created; auto-create is off. */
export const PARKED_TOPIC = 'events.dead-letter-parked' as const;

/** Header the operator tool already writes, kept so consumers see ONE shape. */
export const REPLAYED_HEADER = 'x-usrp-replayed-from-dlq' as const;

/** 1 m, 5 m, 15 m, 1 h, 3 h, 6 h — six re-drives over ~10 h. */
export const DEFAULT_REDRIVE_DELAYS_MS: readonly number[] = [
  60_000,
  300_000,
  900_000,
  3_600_000,
  10_800_000,
  21_600_000,
];

export interface RedrivePolicy {
  /** Delay before re-drive N (1-based); its length is the attempt budget. */
  readonly delaysMs: readonly number[];
  /**
   * Consecutive FAILED re-drives of one (group, source topic) after which the
   * group is parked instead of retried. Protects the platform from a handler
   * that is broken for a reason retrying cannot fix.
   */
  readonly groupFailureThreshold: number;
  /** How many due letters one tick may re-drive, whatever the backlog. */
  readonly maxPerTick: number;
}

export const DEFAULT_REDRIVE_POLICY: RedrivePolicy = {
  delaysMs: DEFAULT_REDRIVE_DELAYS_MS,
  groupFailureThreshold: 3,
  maxPerTick: 50,
};

export function resolveRedrivePolicy(overrides: Partial<RedrivePolicy> = {}): RedrivePolicy {
  const policy: RedrivePolicy = { ...DEFAULT_REDRIVE_POLICY, ...overrides };
  if (policy.delaysMs.length < 1) throw new RangeError('redrive.delaysMs must not be empty');
  if (policy.delaysMs.some((d) => !(d > 0))) throw new RangeError('redrive.delaysMs entries must be > 0');
  if (!Number.isInteger(policy.groupFailureThreshold) || policy.groupFailureThreshold < 1) {
    throw new RangeError('redrive.groupFailureThreshold must be an integer >= 1');
  }
  if (!Number.isInteger(policy.maxPerTick) || policy.maxPerTick < 1) {
    throw new RangeError('redrive.maxPerTick must be an integer >= 1');
  }
  return policy;
}

/** The ledger row the service reads under a claim. */
export interface RedriveLedgerEntry {
  readonly sourceTopic: string;
  readonly sourcePartition: number;
  /** Kafka offsets are 64-bit: kept as a STRING end to end, never a JS number. */
  readonly sourceOffset: string;
  readonly groupId: string;
  readonly reason: DeadLetterReason | 'UNKNOWN';
  /** Completed re-drives so far (0 = the letter has never been re-driven). */
  readonly attempts: number;
  /**
   * RETRYING — still on the schedule;
   * REDRIVEN — successfully republished, job done (the consumer either handles
   *            it or dead-letters it again at a NEW offset, which is a new row);
   * PARKED   — given up, with a closed reason.
   * A row is never deleted: it is the evidence that we tried.
   */
  readonly state: 'RETRYING' | 'REDRIVEN' | 'PARKED';
  /** ISO timestamp the schedule says to knock again. */
  readonly nextAttemptAt: string;
  /** Consecutive failed re-drives of this (group, topic), across letters. */
  readonly consecutiveGroupFailures: number;
}

/** Closed set — an operator alerting on these needs a stable vocabulary. */
export type RedriveParkReason =
  | 'ATTEMPTS_EXHAUSTED'
  | 'NON_RETRYABLE'
  | 'UNDECODABLE'
  | 'REPEATED_FAILURE';

export type RedriveDecision =
  | { readonly kind: 'REDRIVE'; readonly attempt: number }
  | { readonly kind: 'WAIT'; readonly nextAttemptAt: string }
  | { readonly kind: 'PARK'; readonly reason: RedriveParkReason }
  /** Already settled (parked or re-driven): a second worker must not resurrect it. */
  | { readonly kind: 'SKIP'; readonly reason: 'ALREADY_PARKED' | 'ALREADY_REDRIVEN' };

/**
 * Delay before re-drive `attempt` (1-based). Past the end of the schedule the
 * last interval repeats — the caller never exceeds the budget, but a policy
 * with a shorter list must not throw at 03:00.
 */
export function redriveDelayMs(policy: RedrivePolicy, attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), policy.delaysMs.length) - 1;
  return policy.delaysMs[index] ?? policy.delaysMs[policy.delaysMs.length - 1] ?? 60_000;
}

/** When the next attempt is due, given how many have been performed. */
export function nextAttemptAtMs(policy: RedrivePolicy, attempts: number, fromMs: number): number {
  return fromMs + redriveDelayMs(policy, attempts + 1);
}

/**
 * The whole policy. Precedence is deliberate and tested:
 *
 *   1. PARKED / REDRIVEN         → SKIP   (idempotent under a double worker)
 *   2. NON_RETRYABLE / UNDECODABLE → PARK (the letter itself said no)
 *   3. breaker tripped            → PARK   (protect the platform from us)
 *   4. attempts >= budget         → PARK   (never retry forever)
 *   5. nextAttemptAt in future    → WAIT   (the schedule is the ledger's column)
 *   6. otherwise                  → REDRIVE
 *
 * A letter whose reason is UNKNOWN is treated as HANDLER_FAILED-shaped: it is
 * retried, because an unknown dead-letter reason is more likely an old producer
 * than a permanent refusal, and the first failure re-parks it with a reason.
 */
export function decideRedrive(
  entry: RedriveLedgerEntry,
  nowMs: number,
  policy: RedrivePolicy,
): RedriveDecision {
  if (entry.state === 'PARKED') return { kind: 'SKIP', reason: 'ALREADY_PARKED' };
  if (entry.state === 'REDRIVEN') return { kind: 'SKIP', reason: 'ALREADY_REDRIVEN' };

  if (entry.reason === 'NON_RETRYABLE') return { kind: 'PARK', reason: 'NON_RETRYABLE' };
  if (entry.reason === 'UNDECODABLE') return { kind: 'PARK', reason: 'UNDECODABLE' };

  if (entry.consecutiveGroupFailures >= policy.groupFailureThreshold) {
    return { kind: 'PARK', reason: 'REPEATED_FAILURE' };
  }

  if (entry.attempts >= policy.delaysMs.length) return { kind: 'PARK', reason: 'ATTEMPTS_EXHAUSTED' };

  const dueAt = Date.parse(entry.nextAttemptAt);
  // A malformed timestamp is treated as due NOW: parking on a bad value would
  // hide a ledger bug behind "nothing to do".
  if (Number.isFinite(dueAt) && dueAt > nowMs) {
    return { kind: 'WAIT', nextAttemptAt: entry.nextAttemptAt };
  }

  return { kind: 'REDRIVE', attempt: entry.attempts + 1 };
}

/** The ledger identity of a letter — the UNIQUE key that makes a restart safe. */
export function redriveKey(entry: Pick<RedriveLedgerEntry, 'sourceTopic' | 'sourcePartition' | 'sourceOffset' | 'groupId'>): string {
  return `${entry.groupId}|${entry.sourceTopic}|${String(entry.sourcePartition)}|${entry.sourceOffset}`;
}

/** A dead letter as the intake sees it: identity and headers, never the payload. */
export interface DeadLetterHeader {
  readonly groupId: string;
  readonly sourceTopic: string;
  readonly partition: number;
  readonly offset: string;
  readonly reason: DeadLetterReason | 'UNKNOWN';
  /** The event's own id, when the header carried one. */
  readonly eventId: string | null;
}

/**
 * When a newly registered letter is first due. `priorAttempts` is what the same
 * event already spent on earlier letters (0 for a fresh event): inheriting it is
 * what stops "re-drive, fail, new letter, attempts = 0" from looping for ever.
 * Letters that can never be retried are due NOW so they are parked (and
 * signalled) immediately rather than after a pointless wait.
 */
export function firstDueAtMs(
  policy: RedrivePolicy,
  nowMs: number,
  reason: DeadLetterHeader['reason'],
  priorAttempts: number,
): number {
  if (reason === 'NON_RETRYABLE' || reason === 'UNDECODABLE') return nowMs;
  if (priorAttempts >= policy.delaysMs.length) return nowMs; // exhausted: park now
  return nowMs + redriveDelayMs(policy, priorAttempts + 1);
}
