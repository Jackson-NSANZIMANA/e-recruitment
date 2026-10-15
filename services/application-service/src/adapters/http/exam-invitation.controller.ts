// ══════════════════════════════════════════════════════════════════
// application-service — Exam invitation route (ADR-033)
//
//   GET /v1/applications/exam-invitation/by-applicant?applicantId=&applicationId=
//
// SYSTEM token only (identity-service bridges the citizen's session). The body
// is rebuilt from closed fields: the state, the application's public
// identifiers, and — only when READY — the signed token plus the PII-free
// claims a citizen needs to read (venue, date, reporting hour, validity).
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { ApplicationReadError } from '../../domain/application.errors.js';
import type { ExamInvitationService } from '../../application/exam-invitation.service.js';

export const EXAM_INVITATION_BY_APPLICANT_PATH = '/v1/applications/exam-invitation/by-applicant';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string | null, field: string): string {
  const v = value?.trim() ?? '';
  if (!UUID_RE.test(v)) throw new HttpError(400, 'INVALID_REQUEST', `"${field}" must be a UUID.`);
  return v;
}

export function examInvitationRoute(service: ExamInvitationService, verify: AuthVerifier): Route {
  return {
    method: 'GET',
    path: EXAM_INVITATION_BY_APPLICANT_PATH,
    handler: withAuth(verify, { kind: 'system' }, async (ctx): Promise<HttpResult> => {
      const applicantId = uuid(ctx.query.get('applicantId'), 'applicantId');
      const applicationId = uuid(ctx.query.get('applicationId'), 'applicationId');
      let outcome;
      try {
        outcome = await service.forApplicant(applicantId, applicationId);
      } catch (err) {
        if (err instanceof ApplicationReadError) {
          throw new HttpError(500, 'APPLICATION_READ_ERROR', 'Could not read the exam invitation.', { cause: err });
        }
        throw err;
      }
      if (outcome.kind === 'NOT_FOUND') return { status: 404, body: { error: 'NOT_FOUND' } };
      const base = {
        state: outcome.decision.state,
        agency: outcome.agency,
        processingCode: outcome.processingCode,
        campaignLabel: outcome.campaignLabel,
        currentStatus: outcome.currentStatus,
      };
      if (outcome.decision.state !== 'READY') return { status: 200, body: base };
      const c = outcome.decision.claims;
      return {
        status: 200,
        body: {
          ...base,
          invitation: {
            qrPayload: outcome.decision.token,
            ticketId: c.ticketId,
            venueName: c.venueName,
            examDate: c.examDate,
            reportingTimeHour: c.reportingTimeHour,
            validUntil: c.expiresAt,
          },
        },
      };
    }),
  };
}
