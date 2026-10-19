// ══════════════════════════════════════════════════════════════════
// biometric-service — Evidence and policy routes (ADR-037)
//
//   POST /v1/biometric/evidence   officer  biometric.verify
//     { record: USRP-BIO-EVIDENCE.v1, signature }  (≤ 4 KiB)
//     201 { status: RECORDED, recordId, mode, receivedAt[, outcome — ADVISORY only] }
//     200 { status: ALREADY_RECORDED, recordId, mode }   same record, same signature
//     409 { error: REPLAY_CONFLICT | BIOMETRIC_OFF | MODE_MISMATCH[, configuredMode] }
//     422 { error: INVALID_EVIDENCE, reason }
//     403 { error: UNTRUSTED_EVIDENCE, reason } | { error: FORBIDDEN }
//
//   GET  /v1/biometric/policy     officer  biometric.verify
//     200 { agency, mode, legalBasis, evidenceSchema, maxBodyBytes,
//           thresholdPolicy { version, livenessPassBp, matchBp, noMatchBelowBp },
//           referenceSources [{ id, status }] }
//
// The agency and the officer come from the verified token, never the body.
// The body is size-capped HERE as well as at the edge.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { requireOfficerPermission, withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { Agency } from '@usrp/shared-types';
import type { RecordEvidenceOutcome, RecordEvidenceService } from '../../application/record-evidence.service.js';
import { EVIDENCE_SCHEMA, MAX_EVIDENCE_BODY_BYTES, type BiometricLegalBasis } from '../../domain/evidence-record.js';
import type { BiometricMode } from '../../domain/biometric-mode.js';
import { thresholdPolicy } from '../../domain/threshold-policy.js';
import { EvidencePersistenceError } from '../../domain/biometric.errors.js';
import type { ReferenceSourceRegistry } from '../../ports/reference-source.js';
import { EvidenceForbiddenError } from '../evidence-store.pg.js';

export const BIOMETRIC_EVIDENCE_PATH = '/v1/biometric/evidence';
export const BIOMETRIC_POLICY_PATH = '/v1/biometric/policy';

export function mapRecordOutcome(outcome: RecordEvidenceOutcome): HttpResult {
  switch (outcome.kind) {
    case 'RECORDED':
      return {
        status: 201,
        body: {
          status: 'RECORDED',
          recordId: outcome.recordId,
          mode: outcome.mode,
          receivedAt: outcome.receivedAt,
          ...(outcome.mode === 'ADVISORY' && outcome.outcome !== null ? { outcome: outcome.outcome } : {}),
        },
      };
    case 'ALREADY_RECORDED':
      return { status: 200, body: { status: 'ALREADY_RECORDED', recordId: outcome.recordId, mode: outcome.mode } };
    case 'REPLAY_CONFLICT':
      return { status: 409, body: { error: 'REPLAY_CONFLICT' } };
    case 'BIOMETRIC_OFF':
      return { status: 409, body: { error: 'BIOMETRIC_OFF' } };
    case 'MODE_MISMATCH':
      return { status: 409, body: { error: 'MODE_MISMATCH', configuredMode: outcome.configuredMode } };
    case 'INVALID':
      return { status: 422, body: { error: 'INVALID_EVIDENCE', reason: outcome.reason } };
    case 'UNTRUSTED':
      return { status: 403, body: { error: 'UNTRUSTED_EVIDENCE', reason: outcome.reason } };
  }
}

export interface BiometricPolicyView {
  readonly modeFor: (agency: Agency) => BiometricMode;
  readonly thresholdPolicyVersion: string;
  readonly legalBasis: BiometricLegalBasis;
  readonly referenceSources: ReferenceSourceRegistry;
}

export function biometricEvidenceRoutes(
  service: RecordEvidenceService,
  policy: BiometricPolicyView,
  verify: AuthVerifier,
): Route[] {
  return [
    {
      method: 'POST',
      path: BIOMETRIC_EVIDENCE_PATH,
      maxBodyBytes: MAX_EVIDENCE_BODY_BYTES,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'biometric.verify');
        if (principal.kind !== 'officer') throw new HttpError(403, 'FORBIDDEN', 'Officer principal required.');
        const body: unknown = await ctx.json();
        let outcome: RecordEvidenceOutcome;
        try {
          outcome = await service.record({
            agency: principal.agency,
            officerId: principal.subjectId,
            body,
            context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
          });
        } catch (err) {
          if (err instanceof EvidenceForbiddenError) return { status: 403, body: { error: 'FORBIDDEN' } };
          if (err instanceof EvidencePersistenceError) {
            throw new HttpError(500, 'EVIDENCE_PERSISTENCE_ERROR', 'Could not record the evidence.', { cause: err });
          }
          throw new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
        }
        return mapRecordOutcome(outcome);
      }),
    },
    {
      method: 'GET',
      path: BIOMETRIC_POLICY_PATH,
      handler: withAuth(verify, { kind: 'officer' }, (_ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'biometric.verify');
        if (principal.kind !== 'officer') throw new HttpError(403, 'FORBIDDEN', 'Officer principal required.');
        const thresholds = thresholdPolicy(policy.thresholdPolicyVersion);
        if (thresholds === null) throw new HttpError(500, 'INTERNAL_ERROR');
        return Promise.resolve({
          status: 200,
          body: {
            agency: principal.agency,
            mode: policy.modeFor(principal.agency),
            legalBasis: policy.legalBasis,
            evidenceSchema: EVIDENCE_SCHEMA,
            maxBodyBytes: MAX_EVIDENCE_BODY_BYTES,
            thresholdPolicy: {
              version: thresholds.version,
              livenessPassBp: thresholds.livenessPassBp,
              matchBp: thresholds.matchBp,
              noMatchBelowBp: thresholds.noMatchBelowBp,
            },
            referenceSources: policy.referenceSources.all().map((s) => ({ id: s.id, status: s.status })),
          },
        });
      }),
    },
  ];
}
