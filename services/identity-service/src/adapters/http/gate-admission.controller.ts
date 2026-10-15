// ══════════════════════════════════════════════════════════════════
// identity-service — Gate admission front door (BUILD-003, ADR-034)
//
//   POST /v1/gate/admissions                     officer  admission.gate
//     { qrToken, nationalId, gateVenueName }
//
// Why here and not straight to application-service: the officer types the
// national ID from the candidate's card, and identity-service is the ONLY
// holder of NATIONAL_ID_HMAC_KEY. It hashes the number, forgets it, and
// forwards { qrToken, gateVenueName, nationalIdHash } to application-service
// under the officer's OWN bearer token. It decides nothing.
//
// The raw national ID is request-only: it is never logged, never relayed and
// never part of any response (same rule as verify-identity).
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { requireOfficerPermission, withAuth, type AuthVerifier } from '@usrp/shared-auth';
import { hashNationalId, InvalidNationalIdError } from '@usrp/shared-security';
import { UpstreamUnavailableError } from '../../domain/identity.errors.js';
import { projectGateAdmission } from '../../domain/gate-admission-relay.js';
import type { GateAdmissionGateway } from '../../ports/gate-admission-gateway.js';

export const GATE_ADMISSIONS_PATH = '/v1/gate/admissions';

const MAX_TICKET_LENGTH = 4096;
const MISMATCH: HttpResult = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };

function bearerOf(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function gateAdmissionRoutes(
  gateway: GateAdmissionGateway,
  nationalIdHmacKey: string,
  verify: AuthVerifier,
): Route[] {
  return [
    {
      method: 'POST',
      path: GATE_ADMISSIONS_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'admission.gate');
        const raw = await ctx.json<{ qrToken?: unknown; nationalId?: unknown; gateVenueName?: unknown }>();

        const qrToken = typeof raw.qrToken === 'string' ? raw.qrToken.trim() : '';
        if (qrToken.length === 0 || qrToken.length > MAX_TICKET_LENGTH) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "qrToken" is required.');
        }
        const gateVenueName = typeof raw.gateVenueName === 'string' ? raw.gateVenueName.trim() : '';
        if (gateVenueName.length === 0 || gateVenueName.length > 200) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "gateVenueName" must be 1..200 characters.');
        }
        if (typeof raw.nationalId !== 'string') {
          throw new HttpError(400, 'MISSING_NATIONAL_ID', 'Field "nationalId" is required.');
        }
        let nationalIdHash: string;
        try {
          nationalIdHash = hashNationalId(raw.nationalId, nationalIdHmacKey);
        } catch (err) {
          if (err instanceof InvalidNationalIdError) {
            throw new HttpError(400, 'INVALID_NATIONAL_ID', 'The national ID number is not well-formed.');
          }
          throw err;
        }

        // withAuth has verified this exact credential; it is forwarded, not re-minted.
        const bearer = bearerOf(ctx.headers.authorization);
        if (bearer === null) throw new HttpError(401, 'UNAUTHENTICATED');

        let upstream;
        try {
          upstream = await gateway.admit(bearer, { qrToken, gateVenueName, nationalIdHash }, ctx.correlationId);
        } catch (err) {
          if (err instanceof UpstreamUnavailableError) {
            return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
          }
          throw err;
        }

        if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
        if (upstream.status === 401) return { status: 401, body: { error: 'UNAUTHENTICATED' } };
        if (upstream.status === 403) return { status: 403, body: { error: 'PERMISSION_DENIED' } };
        if (upstream.status >= 500) return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
        return projectGateAdmission(upstream.status, upstream.body) ?? MISMATCH;
      }),
    },
  ];
}
