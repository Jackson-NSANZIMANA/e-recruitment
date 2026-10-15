// application-service — Exam invitation for the citizen (ADR-033)

import type { Agency } from '@usrp/shared-types';
import { decideInvitation, type InvitationDecision } from '../domain/exam-invitation.js';
import type { ExamInvitationReader } from '../ports/exam-invitation-reader.js';

export type ExamInvitationOutcome =
  | { readonly kind: 'NOT_FOUND' }
  | {
      readonly kind: 'OK';
      readonly agency: Agency;
      readonly processingCode: string;
      readonly campaignLabel: string | null;
      readonly currentStatus: string;
      readonly decision: InvitationDecision;
    };

export class ExamInvitationService {
  constructor(
    private readonly deps: { readonly reader: ExamInvitationReader; readonly now?: () => Date },
  ) {}

  async forApplicant(applicantId: string, applicationId: string): Promise<ExamInvitationOutcome> {
    const row = await this.deps.reader.findForApplicant(applicantId, applicationId);
    if (row === null) return { kind: 'NOT_FOUND' };
    const now = (this.deps.now ?? ((): Date => new Date()))();
    return {
      kind: 'OK',
      agency: row.agency,
      processingCode: row.processingCode,
      campaignLabel: row.campaignLabel,
      currentStatus: row.status,
      decision: decideInvitation(applicationId, row.status, row.token, now),
    };
  }
}
