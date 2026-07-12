// ══════════════════════════════════════════════════════════════════
// field-sync-service — Enroll-device HTTP ingress
//
// POST /v1/field-sync/devices — an OFFICER-authenticated action. The owning
// agency and the enrolling officer id come from the verified token, never the
// body (the cross-agency invariant). Outcomes → status: ENROLLED 201,
// ALREADY_ENROLLED 200 (idempotent). The device's PRIVATE key never touches the
// server — only its public key is submitted.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { EnrollDeviceService } from '../../application/enroll-device.service.js';

export const ENROLL_DEVICE_PATH = '/v1/field-sync/devices';

interface EnrollBody {
  readonly deviceId?: unknown;
  readonly publicKeyPem?: unknown;
}

function requireString(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'INVALID_FIELD', `Field "${field}" is required.`);
  }
  if (value.length > maxLen) {
    throw new HttpError(400, 'INVALID_FIELD', `Field "${field}" exceeds ${maxLen} characters.`);
  }
  return value;
}

export function enrollDeviceRoute(service: EnrollDeviceService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: ENROLL_DEVICE_PATH,
    handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
      if (principal.kind !== 'officer') {
        throw new HttpError(403, 'FORBIDDEN', 'Officer principal required.');
      }
      const body = await ctx.json<EnrollBody>();
      const deviceId = requireString(body.deviceId, 'deviceId', 64);
      const publicKeyPem = requireString(body.publicKeyPem, 'publicKeyPem', 4096);

      const outcome = await service.enroll({
        deviceId,
        publicKeyPem,
        agency: principal.agency,
        enrolledBy: principal.subjectId,
        context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
      });

      return outcome.kind === 'ENROLLED'
        ? { status: 201, body: { status: 'ENROLLED', deviceId, agency: principal.agency } }
        : { status: 200, body: { status: 'ALREADY_ENROLLED', deviceId, agency: outcome.agency } };
    }),
  };
}
