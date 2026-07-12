// ══════════════════════════════════════════════════════════════════
// field-sync-service — Conflict-resolve HTTP ingress
//
// POST /v1/field-sync/conflicts/resolve — an OFFICER-authenticated adjudication.
// When concurrent offline captures held an application, an officer selects the
// authoritative score row. Agency comes from the token (cross-agency guard).
// Outcomes → status: RESOLVED 200 (application now advances), NOT_FOUND 404,
// NO_CONFLICT 409 (nothing to resolve), SCORE_NOT_FOUND 404.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { ResolveConflictService } from '../../application/resolve-conflict.service.js';

export const RESOLVE_CONFLICT_PATH = '/v1/field-sync/conflicts/resolve';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResolveBody {
  readonly applicationId?: unknown;
  readonly scoreId?: unknown;
  readonly resolution?: unknown;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new HttpError(400, 'INVALID_FIELD', `Field "${field}" must be a UUID.`);
  }
  return value;
}

export function resolveConflictRoute(service: ResolveConflictService, verify: AuthVerifier): Route {
  return {
    method: 'POST',
    path: RESOLVE_CONFLICT_PATH,
    handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
      if (principal.kind !== 'officer') {
        throw new HttpError(403, 'FORBIDDEN', 'Officer principal required.');
      }
      const body = await ctx.json<ResolveBody>();
      const applicationId = requireUuid(body.applicationId, 'applicationId');
      const scoreId = requireUuid(body.scoreId, 'scoreId');
      const resolution = body.resolution;
      if (typeof resolution !== 'string' || resolution.trim().length === 0 || resolution.length > 50) {
        throw new HttpError(400, 'INVALID_FIELD', 'Field "resolution" is required (≤50 chars).');
      }

      const outcome = await service.resolve({
        applicationId,
        agency: principal.agency,
        scoreId,
        resolution,
        resolvedBy: principal.subjectId,
        context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
      });

      switch (outcome.kind) {
        case 'RESOLVED':
          return { status: 200, body: { status: 'RESOLVED', applicationId, scoreId } };
        case 'NOT_FOUND':
          return { status: 404, body: { status: 'NOT_FOUND' } };
        case 'NO_CONFLICT':
          return { status: 409, body: { status: 'NO_CONFLICT' } };
        case 'SCORE_NOT_FOUND':
          return { status: 404, body: { status: 'SCORE_NOT_FOUND' } };
        default:
          return assertNever(outcome);
      }
    }),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled resolve outcome: ${JSON.stringify(value)}`);
}
