// ══════════════════════════════════════════════════════════════════
// identity-service — Erasure request intake use case (ADR-020, owner D10)
//
// The citizen's demand and the DPO's answer, both accountable acts:
// filing a request is audited (the data subject exercised a Law
// N° 058/2021 right — that moment must be evidenceable), and so is a
// decline with its ground. Execution is NOT audited here — the existing
// erasure road (ADR-015) already audits every attempt; this store only
// gets its EXECUTED stamp from that road via markExecuted.
//
// Idempotent re-filing is deliberately NOT re-audited: the audit stream
// records the demand being made, not the citizen refreshing their view.
// ══════════════════════════════════════════════════════════════════

import type { Principal } from '@usrp/shared-auth';
import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { SmsChannel } from '@usrp/shared-sms';
import type { AuditEvent } from '@usrp/shared-types';
import { buildErasureDeclinedBody } from '../domain/erasure-notice.js';
import type {
  DeclineRequestOutcome,
  ErasureRequestRecord,
  ErasureRequestRepository,
  FileRequestOutcome,
} from '../ports/erasure-request.repository.js';

export interface FileErasureRequestCommand {
  /** Session-derived — the data subject themselves, never a body claim. */
  readonly applicantId: string;
  readonly context: EventContext;
}

export interface DeclineErasureRequestCommand {
  readonly requestId: string;
  readonly note: string;
  readonly context: EventContext;
}

export interface ErasureRequestDeps {
  readonly repository: ErasureRequestRepository;
  readonly eventBus: EventBus;
  /**
   * ADR-022 decline notice (owner D14c): when present, a genuine decline
   * sends one FIXED-BODY SMS — never the officer's free-text ground, which
   * stays behind the authenticated portal. Optional — absence turns the
   * notice off.
   */
  readonly sms?: SmsChannel;
}

export class ErasureRequestService {
  constructor(private readonly deps: ErasureRequestDeps) {}

  async file(command: FileErasureRequestCommand): Promise<FileRequestOutcome> {
    const outcome = await this.deps.repository.fileRequest(command.applicantId);
    if (outcome.kind === 'FILED') {
      const event: AuditEvent = {
        ...newEnvelope(command.context),
        eventType: 'AUDIT_ENTRY',
        entityType: 'APPLICANT',
        entityId: command.applicantId,
        action: 'ERASURE_REQUESTED',
        performedBy: command.applicantId,
        agency: 'SYSTEM',
        metadata: { stage: 'SELF_SERVICE', requestId: outcome.requestId },
      };
      await this.deps.eventBus.publish(event);
    }
    return outcome;
  }

  async statusFor(applicantId: string): Promise<ErasureRequestRecord | null> {
    return this.deps.repository.latestForApplicant(applicantId);
  }

  async pendingQueue(): Promise<readonly ErasureRequestRecord[]> {
    return this.deps.repository.listPending();
  }

  async decline(
    command: DeclineErasureRequestCommand,
    officer: Extract<Principal, { kind: 'officer' }>,
  ): Promise<DeclineRequestOutcome> {
    const outcome = await this.deps.repository.decline({
      requestId: command.requestId,
      officerId: officer.subjectId,
      note: command.note,
    });
    if (outcome.kind === 'DECLINED') {
      const event: AuditEvent = {
        ...newEnvelope(command.context),
        eventType: 'AUDIT_ENTRY',
        entityType: 'APPLICANT',
        entityId: outcome.applicantId,
        action: 'ERASURE_REQUEST_DECLINED',
        performedBy: officer.subjectId,
        agency: officer.agency,
        metadata: { requestId: command.requestId, ground: command.note },
      };
      await this.deps.eventBus.publish(event);

      // Decline notice (ADR-022, D14c): best-effort, fixed body — a channel
      // fault must not fail the decline (already recorded + audited above);
      // the outcome is recorded truthfully in the notice's own audit entry.
      if (this.deps.sms) {
        let deliveryStatus: 'DELIVERED' | 'PENDING_NO_CONTACT' | 'FAILED';
        if (outcome.noticeContact === null) {
          deliveryStatus = 'PENDING_NO_CONTACT';
        } else {
          try {
            const sent = await this.deps.sms.send({
              destination: outcome.noticeContact,
              body: buildErasureDeclinedBody(),
            });
            deliveryStatus = sent === 'ACCEPTED' ? 'DELIVERED' : 'FAILED';
          } catch {
            deliveryStatus = 'FAILED';
          }
        }
        const noticeAudit: AuditEvent = {
          ...newEnvelope(command.context),
          eventType: 'AUDIT_ENTRY',
          entityType: 'APPLICANT',
          entityId: outcome.applicantId,
          action: 'ERASURE_DECISION_NOTIFIED',
          performedBy: 'identity-service',
          agency: officer.agency,
          metadata: { decision: 'DECLINED', channel: 'SMS', deliveryStatus },
        };
        await this.deps.eventBus.publish(noticeAudit);
      }
    }
    return outcome;
  }
}
