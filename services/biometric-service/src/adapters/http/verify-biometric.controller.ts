// ══════════════════════════════════════════════════════════════════
// biometric-service — HTTP ingress adapter
//
// POST /v1/biometric/verify — an OFFICER-authenticated check-in action. The
// route is wrapped in withAuth({kind:'officer'}); the officer's agency is
// taken from their verified token and passed to the use case as the
// cross-agency guard (never from the body). Outcomes → status: EVALUATED 200
// (verified true/false in the body), INVALID_INVITATION 422, AGENCY_MISMATCH
// 403. The raw capture reference is never echoed; only scores/verdict return.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { VerifyBiometricOutcome, VerifyBiometricService } from '../../application/verify-biometric.service.js';
import { BiometricMatchError } from '../../domain/biometric.errors.js';

export const VERIFY_BIOMETRIC_PATH = '/v1/biometric/verify';

interface VerifyBody {
  readonly qrSignedToken?: unknown;
  readonly captureRef?: unknown;
}

export function verifyBiometricRoute(service: VerifyBiometricService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: VERIFY_BIOMETRIC_PATH,
    handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
      const body = await ctx.json<VerifyBody>();

      const qrSignedToken = body.qrSignedToken;
      if (typeof qrSignedToken !== 'string' || qrSignedToken.trim().length === 0) {
        throw new HttpError(400, 'MISSING_QR_TOKEN', 'Field "qrSignedToken" is required.');
      }
      const captureRef = body.captureRef;
      if (typeof captureRef !== 'string' || captureRef.trim().length === 0) {
        throw new HttpError(400, 'MISSING_CAPTURE_REF', 'Field "captureRef" is required.');
      }
      if (principal.kind !== 'officer') {
        // withAuth already guarantees this; narrow for the type system.
        throw new HttpError(403, 'FORBIDDEN', 'Officer principal required.');
      }

      let outcome: VerifyBiometricOutcome;
      try {
        outcome = await service.verify({
          qrSignedToken,
          captureRef,
          actorAgency: principal.agency,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
      } catch (err) {
        throw mapError(err);
      }
      return mapOutcome(outcome);
    }),
  };
}

function mapOutcome(outcome: VerifyBiometricOutcome): HttpResult {
  switch (outcome.kind) {
    case 'EVALUATED':
      return {
        status: 200,
        body: {
          status: 'EVALUATED',
          verified: outcome.verified,
          sessionId: outcome.sessionId,
          applicantId: outcome.applicantId,
          livenessPass: outcome.livenessPass,
          faceMatchPass: outcome.faceMatchPass,
        },
      };
    case 'INVALID_INVITATION':
      return { status: 422, body: { status: 'INVALID_INVITATION' } };
    case 'AGENCY_MISMATCH':
      return { status: 403, body: { status: 'AGENCY_MISMATCH' } };
    default:
      return assertNever(outcome);
  }
}

function mapError(err: unknown): HttpError {
  if (err instanceof BiometricMatchError) {
    return new HttpError(503, 'BIOMETRIC_MATCH_UNAVAILABLE', 'The biometric matcher is unavailable.', { cause: err });
  }
  if (err instanceof HttpError) return err;
  return new HttpError(500, 'INTERNAL_ERROR', undefined, { cause: err });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled biometric outcome: ${JSON.stringify(value)}`);
}
