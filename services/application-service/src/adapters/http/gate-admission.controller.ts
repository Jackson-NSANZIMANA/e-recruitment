// ══════════════════════════════════════════════════════════════════
// application-service — Gate admission route (BUILD-003, ADR-034)
//
//   POST /v1/applications/admissions/gate        officer  admission.gate
//
// Reached through identity-service (the only holder of the national-id HMAC
// key), which forwards the OFFICER'S OWN bearer token: authorization here is
// the real human's permission and agency, not a service's assertion. The body
// carries the national-id HASH, never the number. Forging a match would need
// the stored hash, which no browser-facing tier ever sees.
//
//   200  { outcome: ADMITTED, candidate, venueName, examDate, reportingTimeHour,
//          admittedAt, statusAdvanced }
//   409  { error: ALREADY_ADMITTED | NOT_ADMISSIBLE | IDENTITY_MISMATCH |
//          WRONG_VENUE | TOO_EARLY | EXPIRED | MANUAL_IDENTITY_REQUIRED, … }
//          a real ticket, refused here/now (MANUAL_IDENTITY_REQUIRED, ADR-037:
//          a field supervisor must confirm identity first — not a refusal)
//   422  { error: INVALID_TICKET, reason }           not a ticket of this agency
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { requireOfficerPermission, withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { ApplicationPersistenceError } from '../../domain/application.errors.js';
import { MAX_TICKET_LENGTH } from '../../domain/gate-admission.js';
import type { GateAdmissionService } from '../../application/gate-admission.service.js';
import type { GateCandidate } from '../../ports/gate-admission-repository.js';

export const GATE_ADMISSION_PATH = '/v1/applications/admissions/gate';

const HASH_RE = /^[0-9a-f]{64}$/;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function candidateBody(c: GateCandidate): Record<string, unknown> {
  return { applicationId: c.applicationId, processingCode: c.processingCode, category: c.category };
}

export function gateAdmissionRoutes(service: GateAdmissionService, verify: AuthVerifier): Route[] {
  return [
    {
      method: 'POST',
      path: GATE_ADMISSION_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'admission.gate');
        const raw = await ctx.json<{ qrToken?: unknown; gateVenueName?: unknown; nationalIdHash?: unknown }>();

        const qrToken = typeof raw.qrToken === 'string' ? raw.qrToken.trim() : '';
        if (qrToken.length === 0 || qrToken.length > MAX_TICKET_LENGTH) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "qrToken" is required.');
        }
        const gateVenueName = typeof raw.gateVenueName === 'string' ? raw.gateVenueName.normalize('NFC').trim() : '';
        if (gateVenueName.length === 0 || gateVenueName.length > 200 || hasControlCharacters(gateVenueName)) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "gateVenueName" must be 1..200 printable characters.');
        }
        if (typeof raw.nationalIdHash !== 'string' || !HASH_RE.test(raw.nationalIdHash)) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "nationalIdHash" must be a lowercase SHA-256 hex digest.');
        }

        let result;
        try {
          result = await service.admit({
            actor: principal,
            token: qrToken,
            gateVenueName,
            nationalIdHash: raw.nationalIdHash,
            context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
          });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          if (err instanceof ApplicationPersistenceError) {
            throw new HttpError(500, 'APPLICATION_PERSISTENCE_ERROR', 'Could not record the admission.', { cause: err });
          }
          throw new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
        }

        switch (result.outcome) {
          case 'FORBIDDEN':
            return { status: 403, body: { error: 'FORBIDDEN' } };
          case 'ADMITTED':
            return {
              status: 200,
              body: {
                outcome: 'ADMITTED',
                candidate: candidateBody(result.candidate),
                venueName: result.venueName,
                examDate: result.examDate,
                reportingTimeHour: result.reportingTimeHour,
                admittedAt: result.admittedAt,
                statusAdvanced: result.advancedTo !== null,
                identityMethod: result.identityMethod,
              },
            };
          case 'ALREADY_ADMITTED':
            return {
              status: 409,
              body: {
                error: 'ALREADY_ADMITTED',
                candidate: candidateBody(result.candidate),
                admittedAt: result.admittedAt,
                venueName: result.venueName,
                admittedBySelf: result.admittedBySelf,
              },
            };
          case 'NOT_ADMISSIBLE':
            return {
              status: 409,
              body: { error: 'NOT_ADMISSIBLE', candidate: candidateBody(result.candidate), currentStatus: result.currentStatus },
            };
          case 'IDENTITY_MISMATCH':
            return { status: 409, body: { error: 'IDENTITY_MISMATCH', candidate: candidateBody(result.candidate) } };
          case 'MANUAL_IDENTITY_REQUIRED':
            return { status: 409, body: { error: 'MANUAL_IDENTITY_REQUIRED', candidate: candidateBody(result.candidate) } };
          case 'WRONG_VENUE':
            return { status: 409, body: { error: 'WRONG_VENUE', ticketVenueName: result.ticketVenueName } };
          case 'TOO_EARLY':
          case 'EXPIRED':
            return { status: 409, body: { error: result.outcome, examDate: result.examDate } };
          case 'MALFORMED_TICKET':
          case 'WRONG_AGENCY':
          case 'UNKNOWN_TICKET':
          case 'TICKET_NOT_ISSUED':
            return { status: 422, body: { error: 'INVALID_TICKET', reason: result.outcome } };
        }
      }),
    },
  ];
}
