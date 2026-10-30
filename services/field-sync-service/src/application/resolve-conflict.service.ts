// ══════════════════════════════════════════════════════════════════
// field-sync-service — ResolveConflict use case
//
// A human path (ADR-010 §3): when two offline devices produced concurrent
// scores, the application was HELD — no official result was silently chosen. An
// authorised officer picks the authoritative record; this clears the conflict,
// records sync_conflict_resolution, and NOW emits FIELD_SCORE_CAPTURED for the
// chosen record so application-service can finally advance the application to
// PHYSICAL_TEST_COMPLETE. The losing records are retained (immutable history).
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, AuditEvent, FieldScoreCapturedEvent } from '@usrp/shared-types';
import type { FieldScoreStore, ResolveOutcome } from '../ports/field-score-store.js';

export interface ResolveConflictCommand {
  readonly applicationId: string;
  readonly agency: Agency;
  readonly scoreId: string;
  readonly resolution: string;
  /** The adjudicating officer's opaque subject id. */
  readonly resolvedBy: string;
  readonly context: EventContext;
}

export interface ResolveConflictDeps {
  readonly store: FieldScoreStore;
  readonly eventBus: EventBus;
}

export class ResolveConflictService {
  constructor(private readonly deps: ResolveConflictDeps) {}

  async resolve(command: ResolveConflictCommand): Promise<ResolveOutcome> {
    const outcome = await this.deps.store.resolveConflict({
      applicationId: command.applicationId,
      agency: command.agency,
      scoreId: command.scoreId,
      resolution: command.resolution,
    });

    if (outcome.kind !== 'RESOLVED') return outcome;

    // The chosen record now flows downstream exactly like a clean capture.
    const captured: FieldScoreCapturedEvent = {
      ...newEnvelope(command.context),
      eventType: 'FIELD_SCORE_CAPTURED',
      applicationId: command.applicationId,
      agency: command.agency,
      campaignId: outcome.campaignId,
      deviceId: outcome.deviceId,
      capturingOfficerId: outcome.capturingOfficerId,
      vectorClock: outcome.vectorClock,
      signedPayloadHash: outcome.signedPayloadHash,
      isWalkIn: outcome.isWalkIn,
    };
    await this.deps.eventBus.publish(captured);

    // FOUR-EYES IS RECORDABLE, SO IT IS RECORDED (evaluation D11).
    //
    // The rule "an officer may not adjudicate a conflict their own capture
    // created" needs three facts, and all three are already here: the resolving
    // officer (the officer's opaque subject from the verified token), the
    // capturing officer of the record that won (`capturing_officer_id`, written
    // by the signed sync), and their agency. What was missing was the
    // COMPARISON, so the trail could not answer the question after the fact.
    //
    // It is recorded rather than enforced on purpose: the SoD policy is the
    // owner's to ratify (ROADMAP §6.6), and at a one-venue exam day the same
    // officer legitimately does both. A refusal invented here would stop an
    // honest day; a recorded fact cannot be un-recorded. When the rule is
    // ratified it becomes a refusal at this same point, with the evidence
    // already collected.
    const sameOfficer = outcome.capturingOfficerId === command.resolvedBy;

    const audit: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.applicationId,
      action: 'FIELD_SCORE_CONFLICT_RESOLVED',
      performedBy: command.resolvedBy,
      agency: command.agency,
      metadata: {
        scoreId: command.scoreId,
        resolution: command.resolution,
        capturingOfficerId: outcome.capturingOfficerId,
        resolverIsCapturingOfficer: sameOfficer,
      },
    };
    await this.deps.eventBus.publish(audit);

    return outcome;
  }
}
