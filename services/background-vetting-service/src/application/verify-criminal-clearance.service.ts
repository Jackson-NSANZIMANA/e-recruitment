// ══════════════════════════════════════════════════════════════════
// background-vetting-service — Verify criminal clearance (use case)
//
// Fetch the applicant's RIB records status, apply the per-category conviction
// threshold, and record the decision on the backbone. Two events are emitted,
// exactly mirroring the NESA education gate:
//
//   • RIB_VETTING_COMPLETED  → vetting.rib      (the domain result for any
//                                                downstream projector)
//   • AUDIT_ENTRY            → audit.immutable   (the forensic record)
//
// This gate is STATELESS by deliberate design — it writes no application row.
// Every eligibility/vetting gate in USRP today is a pure emitter; who projects
// these verdicts onto application.criminal_clearance_status is a single
// cross-cutting decision (an ADR), not something to smuggle asymmetrically
// into this one slice. The RIB_VETTING_COMPLETED event carries everything
// (applicationId, clearanceStatus, appliedThreshold) a future projector needs.
//
// The applicant's raw National ID never appears — the request keys on the
// internal nationalIdHash and the events carry only references + the verdict.
// RibUnavailableError PROPAGATES (never swallowed) so the event-driven caller
// leaves the Kafka offset uncommitted and the vetting is retried — we never
// fabricate a clearance from an unreachable registry.
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import {
  agencyForCategory,
  type Agency,
  type ApplicationCategory,
  type AuditEvent,
  type RIBVettingCompletedEvent,
} from '@usrp/shared-types';
import type { RibGateway } from '../ports/rib.gateway.js';
import { evaluateCriminalClearance, type CriminalClearanceDecision } from '../domain/criminal-rules.js';

export interface VerifyCriminalClearanceCommand {
  readonly applicantId: string;
  readonly applicationId: string;
  readonly category: ApplicationCategory;
  /** Internal system-wide applicant key — carried by APPLICANT_SUBMITTED. */
  readonly nationalIdHash: string;
  /** Inbound correlation context; a fresh chain starts when omitted. */
  readonly context?: EventContext;
}

export interface VerifyCriminalClearanceOutcome {
  readonly kind: 'VETTED';
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  readonly decision: CriminalClearanceDecision;
  readonly ribRequestId: string;
  readonly vettingEvent: RIBVettingCompletedEvent;
  readonly auditEvent: AuditEvent;
}

export interface VerifyCriminalClearanceDeps {
  readonly ribGateway: RibGateway;
  readonly eventBus: EventBus;
}

export class VerifyCriminalClearanceService {
  constructor(private readonly deps: VerifyCriminalClearanceDeps) {}

  async verify(command: VerifyCriminalClearanceCommand): Promise<VerifyCriminalClearanceOutcome> {
    // Fetch RIB's coarse records flag (throws RibUnavailableError on fault).
    const rib = await this.deps.ribGateway.checkVetting(command.nationalIdHash);

    // Pure policy: RIB flag × per-category threshold → clearance verdict.
    const decision = evaluateCriminalClearance(command.category, rib.status);

    // Derive the owning agency from the category — the platform-wide source of
    // truth (@usrp/shared-types), not a trusted inbound field.
    const agency = agencyForCategory(command.category);
    const context = command.context ?? newCorrelationContext();

    // 1) The domain result — for any downstream projector/consumer.
    const vettingEvent: RIBVettingCompletedEvent = {
      ...newEnvelope(context),
      eventType: 'RIB_VETTING_COMPLETED',
      applicantId: command.applicantId,
      applicationId: command.applicationId,
      agency,
      category: command.category,
      ribRequestId: rib.ribRequestId,
      clearanceStatus: decision.clearanceStatus,
      appliedThreshold: decision.appliedThreshold,
    };
    await this.deps.eventBus.publish(vettingEvent);

    // 2) The immutable forensic record. References + derived verdict only —
    // no raw NID (the nationalIdHash is itself a non-reversible reference and
    // deliberately excluded from the audit metadata too).
    const auditEvent: AuditEvent = {
      ...newEnvelope(context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'APPLICATION',
      entityId: command.applicationId,
      action: decision.cleared ? 'CRIMINAL_CLEARANCE_PASSED' : 'CRIMINAL_CLEARANCE_FLAGGED',
      performedBy: 'background-vetting-service',
      agency,
      metadata: {
        applicantId: command.applicantId,
        category: command.category,
        ribStatus: rib.status,
        clearanceStatus: decision.clearanceStatus,
        appliedThreshold: decision.appliedThreshold,
        cleared: decision.cleared,
        reason: decision.reason,
        ribRequestId: rib.ribRequestId,
      },
    };
    await this.deps.eventBus.publish(auditEvent);

    return {
      kind: 'VETTED',
      applicantId: command.applicantId,
      applicationId: command.applicationId,
      agency,
      category: command.category,
      decision,
      ribRequestId: rib.ribRequestId,
      vettingEvent,
      auditEvent,
    };
  }
}
