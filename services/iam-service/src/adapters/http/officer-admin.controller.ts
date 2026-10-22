// ══════════════════════════════════════════════════════════════════
// iam-service — HTTP ingress for the officer lifecycle (ADR-036)
//
//   GET  /v1/officers                         officer.read          → 200 { officers }
//   POST /v1/officers                         officer.create        → 201 { outcome, officer }   (NEVER a code)
//   POST /v1/officers/activation/reissue      officer.create        → 200 { outcome, officer }   (NEVER a code)
//   POST /v1/officers/activation/release      officer.create        → 200 { outcome, officer, activation }
//        a DIFFERENT administrator only: SAME_ADMIN 403, ALREADY_RELEASED 409 (ADR-036 addendum)
//   POST /v1/officers/posts                   officer.posts.assign  → 200 { outcome, officer, sessionsRevoked }
//   POST /v1/officers/disable                 officer.disable       → 200 { … }
//   POST /v1/officers/enable                  officer.disable       → 200 { … }
//   POST /v1/officers/sessions/revoke         officer.sessions.revoke → 200 { … }
//   POST /v1/auth/officer/activate            anonymous (the code is the credential) → 204
//
// Officer bearer token required (withAuth) and the permission checked here
// (requireOfficerPermission); the rls/0033 functions check the actor's LIVE
// row again, so a disabled administrator's still-valid token is refused with
// the same 403. The agency is the principal's; a body naming any field other
// than the command's own is a 400 (no agency, no actor, no status smuggling).
// The target travels as `targetOfficerId`.
//
// Refusals name a closed rule, never a person. A target in another agency is
// a bare 404, identical to a nonexistent id.
// ══════════════════════════════════════════════════════════════════

import {
  requireOfficerPermission,
  withAuth,
  type AuthVerifier,
  type Permission,
  type Principal,
} from '@usrp/shared-auth';
import { HttpError, type HttpResult, type RequestContext, type Route } from '@usrp/shared-http';
import type { OfficerRefusal, OfficerView } from '../../domain/officer-admin.js';
import { OfficerAdminForbiddenError } from '../../domain/iam.errors.js';
import type { AdminPrincipal, InvalidRequest, OfficerAdminService } from '../../application/officer-admin.service.js';
import type {
  CreateOfficerResult,
  OfficerChangeResult,
  ReissueActivationResult,
  ReleaseActivationResult,
} from '../../ports/officer-admin-repository.js';

export const OFFICERS_PATH = '/v1/officers';
export const OFFICER_REISSUE_ACTIVATION_PATH = '/v1/officers/activation/reissue';
export const OFFICER_RELEASE_ACTIVATION_PATH = '/v1/officers/activation/release';
export const OFFICER_POSTS_PATH = '/v1/officers/posts';
export const OFFICER_DISABLE_PATH = '/v1/officers/disable';
export const OFFICER_ENABLE_PATH = '/v1/officers/enable';
export const OFFICER_REVOKE_SESSIONS_PATH = '/v1/officers/sessions/revoke';
export const OFFICER_ACTIVATE_PATH = '/v1/auth/officer/activate';

/** HTTP status per refusal. Shape refusals are 422; policy refusals 403/409. */
const REFUSAL_STATUS: Readonly<Record<OfficerRefusal, number>> = {
  INVALID_HANDLE: 422,
  INVALID_POSTS: 422,
  UNKNOWN_POST: 422,
  INVALID_REASON: 422,
  AGENCY_ADMIN_NOT_ASSIGNABLE: 403,
  SELF_MODIFICATION: 403,
  NOT_FOUND: 404,
  HANDLE_TAKEN: 409,
  LAST_ACTIVE_ADMIN: 409,
  NOT_PENDING_ACTIVATION: 409,
  SAME_ADMIN: 403,
  ALREADY_RELEASED: 409,
  ACTIVATION_EXPIRED: 409,
};

function refusedResult(reason: OfficerRefusal): HttpResult {
  return { status: REFUSAL_STATUS[reason], body: { error: reason } };
}

/** Parse a JSON object body whose keys are exactly within `allowed`. */
async function commandBody(ctx: RequestContext, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const body = await ctx.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'A JSON object body is required.');
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, 'INVALID_REQUEST', 'The request names a field this command does not accept.');
  }
  return record;
}

function adminPrincipal(principal: Principal, permission: Permission, ctx: RequestContext): AdminPrincipal {
  requireOfficerPermission(principal, permission);
  if (principal.kind !== 'officer') {
    // requireOfficerPermission already refused any non-officer; this narrows the type.
    throw new HttpError(403, 'PERMISSION_DENIED', 'Your role does not permit this operation.');
  }
  return { subjectId: principal.subjectId, agency: principal.agency, correlationId: ctx.correlationId };
}

/** The database refusing the actor is the same 403 the permission check gives. */
async function asAdmin(run: () => Promise<HttpResult>): Promise<HttpResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof OfficerAdminForbiddenError) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'Your role does not permit this operation.');
    }
    throw err;
  }
}

function viewBody(officer: OfficerView): Record<string, unknown> {
  return {
    officerId: officer.officerId,
    loginHandle: officer.loginHandle,
    posts: officer.posts,
    status: officer.status,
    createdAt: officer.createdAt,
    activatedAt: officer.activatedAt,
    lastLoginAt: officer.lastLoginAt,
    activationExpiresAt: officer.activationExpiresAt,
    activationState: officer.activationState,
    releasableByYou: officer.releasableByYou,
  };
}

function changeResult(result: OfficerChangeResult | InvalidRequest): HttpResult {
  if (result.outcome === 'INVALID_REQUEST') {
    return { status: 400, body: { error: 'INVALID_REQUEST', field: result.field } };
  }
  if (result.outcome === 'REFUSED') return refusedResult(result.reason);
  return {
    status: 200,
    body: { outcome: result.outcome, officer: viewBody(result.officer), sessionsRevoked: result.sessionsRevoked },
  };
}

/** create / reissue: the officer only. The creating administrator never receives a code. */
function openedResult(
  result: CreateOfficerResult | ReissueActivationResult | InvalidRequest,
  successStatus: number,
): HttpResult {
  if (result.outcome === 'INVALID_REQUEST') {
    return { status: 400, body: { error: 'INVALID_REQUEST', field: result.field } };
  }
  if (result.outcome === 'REFUSED') return refusedResult(result.reason);
  return { status: successStatus, body: { outcome: result.outcome, officer: viewBody(result.officer) } };
}

/** release: the only answer that carries a code, to a different administrator, once. */
function releasedResult(result: ReleaseActivationResult | InvalidRequest): HttpResult {
  if (result.outcome === 'INVALID_REQUEST') {
    return { status: 400, body: { error: 'INVALID_REQUEST', field: result.field } };
  }
  if (result.outcome === 'REFUSED') return refusedResult(result.reason);
  return {
    status: 200,
    body: {
      outcome: result.outcome,
      officer: viewBody(result.officer),
      activation: { code: result.activation.code, expiresAt: result.activation.expiresAt },
    },
  };
}

/** The administrator routes (authenticated) plus the anonymous activation route. */
export function officerAdminRoutes(service: OfficerAdminService, verify: AuthVerifier): Route[] {
  const officer = { kind: 'officer' } as const;
  return [
    {
      method: 'GET',
      path: OFFICERS_PATH,
      handler: withAuth(verify, officer, async (ctx, principal) => asAdmin(async () => {
        const actor = adminPrincipal(principal, 'officer.read', ctx);
        const officers = await service.list(actor);
        return { status: 200, body: { officers: officers.map(viewBody) } };
      })),
    },
    {
      method: 'POST',
      path: OFFICERS_PATH,
      handler: withAuth(verify, officer, async (ctx, principal) => asAdmin(async () => {
        const actor = adminPrincipal(principal, 'officer.create', ctx);
        const body = await commandBody(ctx, ['loginHandle', 'posts']);
        return openedResult(await service.create(actor, body['loginHandle'], body['posts']), 201);
      })),
    },
    {
      method: 'POST',
      path: OFFICER_REISSUE_ACTIVATION_PATH,
      handler: withAuth(verify, officer, async (ctx, principal) => asAdmin(async () => {
        const actor = adminPrincipal(principal, 'officer.create', ctx);
        const body = await commandBody(ctx, ['targetOfficerId']);
        return openedResult(await service.reissueActivation(actor, body['targetOfficerId']), 200);
      })),
    },
    {
      method: 'POST',
      path: OFFICER_RELEASE_ACTIVATION_PATH,
      handler: withAuth(verify, officer, async (ctx, principal) => asAdmin(async () => {
        const actor = adminPrincipal(principal, 'officer.create', ctx);
        const body = await commandBody(ctx, ['targetOfficerId']);
        return releasedResult(await service.releaseActivation(actor, body['targetOfficerId']));
      })),
    },
    {
      method: 'POST',
      path: OFFICER_POSTS_PATH,
      handler: withAuth(verify, officer, async (ctx, principal) => asAdmin(async () => {
        const actor = adminPrincipal(principal, 'officer.posts.assign', ctx);
        const body = await commandBody(ctx, ['targetOfficerId', 'posts', 'reasonCode']);
        return changeResult(await service.assignPosts(actor, body['targetOfficerId'], body['posts'], body['reasonCode']));
      })),
    },
    {
      method: 'POST',
      path: OFFICER_DISABLE_PATH,
      handler: withAuth(verify, officer, async (ctx, principal) => asAdmin(async () => {
        const actor = adminPrincipal(principal, 'officer.disable', ctx);
        const body = await commandBody(ctx, ['targetOfficerId', 'reasonCode']);
        return changeResult(await service.setStatus(actor, body['targetOfficerId'], 'disabled', body['reasonCode']));
      })),
    },
    {
      method: 'POST',
      path: OFFICER_ENABLE_PATH,
      handler: withAuth(verify, officer, async (ctx, principal) => asAdmin(async () => {
        const actor = adminPrincipal(principal, 'officer.disable', ctx);
        const body = await commandBody(ctx, ['targetOfficerId', 'reasonCode']);
        return changeResult(await service.setStatus(actor, body['targetOfficerId'], 'active', body['reasonCode']));
      })),
    },
    {
      method: 'POST',
      path: OFFICER_REVOKE_SESSIONS_PATH,
      handler: withAuth(verify, officer, async (ctx, principal) => asAdmin(async () => {
        const actor = adminPrincipal(principal, 'officer.sessions.revoke', ctx);
        const body = await commandBody(ctx, ['targetOfficerId', 'reasonCode']);
        return changeResult(await service.revokeSessions(actor, body['targetOfficerId'], body['reasonCode']));
      })),
    },
    {
      // The third UNauthenticated route: the activation code IS the credential.
      method: 'POST',
      path: OFFICER_ACTIVATE_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const body = await commandBody(ctx, ['loginHandle', 'activationCode', 'password']);
        const outcome = await service.activate(
          body['loginHandle'],
          body['activationCode'],
          body['password'],
          ctx.correlationId,
        );
        if (outcome.outcome === 'WEAK_PASSWORD') {
          return { status: 400, body: { error: 'WEAK_PASSWORD' } };
        }
        if (outcome.outcome === 'REJECTED') {
          return { status: 401, body: { error: 'ACTIVATION_REJECTED' } };
        }
        return { status: 204 };
      },
    },
  ];
}
