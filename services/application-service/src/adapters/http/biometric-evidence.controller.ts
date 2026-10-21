// ══════════════════════════════════════════════════════════════════
// application-service — Biometric evidence routes (ADR-037)
//
//   GET  /v1/applications/biometric-evidence?applicationId=      officer  biometric.evidence.read
//     200 { applicationId, evidence: [ { recordId, ticketId, referenceSource,
//           method, consentState, outcome, notAttemptedReason, livenessScoreBp,
//           matchScoreBp, modelId, modelVersion, thresholdPolicyVersion, mode,
//           capturedAt, receivedAt, manualIdentity { reasonCode, confirmedAt } | null } ] }
//     404 NOT_FOUND (nonexistent and another agency's are the same answer)
//     ADVISORY rows only. No device id, key id, signature or officer id.
//
//   POST /v1/applications/biometric-evidence/manual-identity      officer  identity.manual.confirm
//     { recordId, reasonCode }
//     201 { status: CONFIRMED, confirmationId, recordId, confirmedAt }
//     403 FORBIDDEN (engine: not an active field supervisor of the agency)
//     404 NOT_FOUND | 409 NOT_REQUIRED | ALREADY_CONFIRMED | SAME_OFFICER
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { requireOfficerPermission, withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { ApplicationPersistenceError } from '../../domain/application.errors.js';
import { isManualIdentityReason } from '../../domain/gate-identity.js';
import type { BiometricEvidenceService } from '../../application/biometric-evidence.service.js';
import type { EvidenceView } from '../../ports/biometric-evidence-repository.js';

export const BIOMETRIC_EVIDENCE_READ_PATH = '/v1/applications/biometric-evidence';
export const MANUAL_IDENTITY_PATH = '/v1/applications/biometric-evidence/manual-identity';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuid(value: unknown, field: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!UUID_RE.test(v)) throw new HttpError(400, 'INVALID_REQUEST', `"${field}" must be a lowercase UUID.`);
  return v;
}

function viewBody(e: EvidenceView): Record<string, unknown> {
  return {
    recordId: e.recordId,
    ticketId: e.ticketId,
    referenceSource: e.referenceSource,
    method: e.method,
    consentState: e.consentState,
    outcome: e.outcome,
    notAttemptedReason: e.notAttemptedReason,
    livenessScoreBp: e.livenessScoreBp,
    matchScoreBp: e.matchScoreBp,
    modelId: e.modelId,
    modelVersion: e.modelVersion,
    thresholdPolicyVersion: e.thresholdPolicyVersion,
    mode: e.mode,
    capturedAt: e.capturedAt,
    receivedAt: e.receivedAt,
    manualIdentity: e.manualIdentity === null
      ? null
      : { reasonCode: e.manualIdentity.reasonCode, confirmedAt: e.manualIdentity.confirmedAt },
  };
}

function mapError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ApplicationPersistenceError) {
    return new HttpError(500, 'APPLICATION_PERSISTENCE_ERROR', 'Could not process biometric evidence.', { cause: err });
  }
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

export function biometricEvidenceRoutes(service: BiometricEvidenceService, verify: AuthVerifier): Route[] {
  return [
    {
      method: 'GET',
      path: BIOMETRIC_EVIDENCE_READ_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'biometric.evidence.read');
        const applicationId = uuid(ctx.query.get('applicationId'), 'applicationId');
        try {
          const outcome = await service.list(principal, applicationId);
          return outcome.kind === 'OK'
            ? { status: 200, body: { applicationId: outcome.applicationId, evidence: outcome.evidence.map(viewBody) } }
            : { status: 404, body: { error: 'NOT_FOUND' } };
        } catch (err) {
          throw mapError(err);
        }
      }),
    },
    {
      method: 'POST',
      path: MANUAL_IDENTITY_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'identity.manual.confirm');
        const raw = await ctx.json<{ recordId?: unknown; reasonCode?: unknown }>();
        const recordId = uuid(raw.recordId, 'recordId');
        if (!isManualIdentityReason(raw.reasonCode)) {
          throw new HttpError(400, 'INVALID_REASON', '"reasonCode" is not a manual-identity reason code.');
        }
        try {
          const outcome = await service.confirm(principal, recordId, raw.reasonCode, {
            correlationId: ctx.correlationId,
            causationId: ctx.correlationId,
          });
          switch (outcome.kind) {
            case 'CONFIRMED':
              return {
                status: 201,
                body: { status: 'CONFIRMED', confirmationId: outcome.confirmationId, recordId: outcome.recordId, confirmedAt: outcome.confirmedAt },
              };
            case 'NOT_FOUND':
              return { status: 404, body: { error: 'NOT_FOUND' } };
            case 'NOT_REQUIRED':
            case 'ALREADY_CONFIRMED':
            case 'SAME_OFFICER':
              return { status: 409, body: { error: outcome.kind } };
            case 'FORBIDDEN':
              return { status: 403, body: { error: 'FORBIDDEN' } };
          }
        } catch (err) {
          throw mapError(err);
        }
      }),
    },
  ];
}
