// ══════════════════════════════════════════════════════════════════
// identity-service — Retention sweep (use case, ADR-019)
//
// Storage limitation made mechanical (Law N° 058/2021): PII the platform
// no longer has grounds to keep is destroyed on a schedule, not on
// demand. Owner D7 (2026-07-26) pinned the periods and the posture:
//
//   • never-applied identities      → tombstone after 12 months
//   • all-negative-terminal         → tombstone after 24 months
//   • dead sessions/OTP challenges  → hard-delete after expiry + 30 days
//   • applications/history/audit    → NEVER swept (engine-immutable,
//     PII-free after the subject's tombstone; 7y/10y record horizons)
//
// DRY-RUN IS THE DEFAULT: report() only reads. execute() erases each
// candidate through the SAME ErasureRepository the citizen-demand path
// uses — the terminal-only/accept-lock gate is re-checked inside that
// transaction, so a candidate whose state changed since discovery is
// SKIPPED (reported, not forced). Every executed tombstone is audited
// (RETENTION_ERASURE_EXECUTED, performedBy 'retention-sweep') — a
// retention erasure is the controller's own accountable act, distinct
// from a citizen-demanded ERASURE_EXECUTED.
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope, type EventBus } from '@usrp/shared-events';
import type { AuditEvent } from '@usrp/shared-types';
import type { ErasureRepository } from '../ports/erasure-repository.js';
import type { RetentionRepository } from '../ports/retention-repository.js';

export interface RetentionPolicy {
  readonly neverAppliedMonths: number;
  readonly negativeTerminalMonths: number;
  readonly purgeGraceDays: number;
}

/** What the sweep WOULD do (dry-run) — or just did (inside SweepResult). */
export interface SweepReport {
  readonly cutoffs: {
    readonly neverApplied: string;
    readonly negativeTerminal: string;
    readonly purge: string;
  };
  readonly neverApplied: readonly string[];
  readonly negativeTerminal: readonly string[];
  readonly purgeableSessions: number;
  readonly purgeableChallenges: number;
}

export interface SweepResult {
  readonly report: SweepReport;
  readonly erased: readonly string[];
  /** Candidates the erasure gate refused at execution time (state changed
   * between discovery and execution) — reported, never forced. */
  readonly skipped: readonly { readonly applicantId: string; readonly reason: string }[];
  readonly purgedSessions: number;
  readonly purgedChallenges: number;
}

export interface RetentionSweepDeps {
  readonly retention: RetentionRepository;
  readonly erasure: ErasureRepository;
  readonly eventBus: EventBus;
  readonly policy: RetentionPolicy;
  readonly now?: () => Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class RetentionSweepService {
  readonly #now: () => Date;

  constructor(private readonly deps: RetentionSweepDeps) {
    this.#now = deps.now ?? ((): Date => new Date());
  }

  /** Read-only: what the policy would sweep right now. Writes NOTHING. */
  async report(): Promise<SweepReport> {
    const now = this.#now();
    const neverAppliedCutoff = monthsBefore(now, this.deps.policy.neverAppliedMonths);
    const negativeCutoff = monthsBefore(now, this.deps.policy.negativeTerminalMonths);
    const purgeCutoff = new Date(now.getTime() - this.deps.policy.purgeGraceDays * MS_PER_DAY);

    return {
      cutoffs: {
        neverApplied: neverAppliedCutoff.toISOString(),
        negativeTerminal: negativeCutoff.toISOString(),
        purge: purgeCutoff.toISOString(),
      },
      neverApplied: await this.deps.retention.findNeverApplied(neverAppliedCutoff),
      negativeTerminal: await this.deps.retention.findNegativeTerminal(negativeCutoff),
      purgeableSessions: await this.deps.retention.countPurgeableSessions(purgeCutoff),
      purgeableChallenges: await this.deps.retention.countPurgeableChallenges(purgeCutoff),
    };
  }

  /** Perform the sweep: tombstone eligible identities (through the gated
   * erasure path), purge dead sessions/challenges, audit each tombstone. */
  async execute(): Promise<SweepResult> {
    const report = await this.report();
    const erased: string[] = [];
    const skipped: { applicantId: string; reason: string }[] = [];

    const classes: ReadonlyArray<readonly [readonly string[], 'NEVER_APPLIED' | 'NEGATIVE_TERMINAL']> = [
      [report.neverApplied, 'NEVER_APPLIED'],
      [report.negativeTerminal, 'NEGATIVE_TERMINAL'],
    ];
    for (const [candidates, retentionClass] of classes) {
      for (const applicantId of candidates) {
        const outcome = await this.deps.erasure.eraseIdentity(applicantId);
        if (outcome.kind === 'ERASED') {
          erased.push(applicantId);
          await this.#auditErased(applicantId, retentionClass);
        } else if (outcome.kind !== 'ALREADY_ERASED') {
          // The gate said no at execution time — never force, just report.
          skipped.push({ applicantId, reason: outcome.kind });
        }
      }
    }

    const purgeCutoff = new Date(Date.parse(report.cutoffs.purge));
    const purgedSessions = await this.deps.retention.purgeSessions(purgeCutoff);
    const purgedChallenges = await this.deps.retention.purgeChallenges(purgeCutoff);

    return { report, erased, skipped, purgedSessions, purgedChallenges };
  }

  async #auditErased(applicantId: string, retentionClass: string): Promise<void> {
    const event: AuditEvent = {
      ...newEnvelope(newCorrelationContext()),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICANT',
      entityId: applicantId,
      action: 'RETENTION_ERASURE_EXECUTED',
      performedBy: 'retention-sweep',
      agency: 'SYSTEM',
      metadata: { class: retentionClass, policy: 'ADR-019/D7' },
    };
    await this.deps.eventBus.publish(event);
  }
}

/** Calendar-months-before, clamped by Date's own day-overflow rules. */
function monthsBefore(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}
