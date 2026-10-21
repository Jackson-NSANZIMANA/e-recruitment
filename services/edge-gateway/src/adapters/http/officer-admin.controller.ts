// ══════════════════════════════════════════════════════════════════
// edge-gateway — Officer lifecycle (ADR-036)
//
//   GET  /edge/v1/officers                        officer.read            listOfficers
//   POST /edge/v1/officers                        officer.create          createOfficer
//   POST /edge/v1/officers/activation/reissue     officer.create          reissueOfficerActivation
//   POST /edge/v1/officers/activation/release     officer.create          releaseOfficerActivation
//   POST /edge/v1/officers/posts                  officer.posts.assign    assignOfficerPosts
//   POST /edge/v1/officers/disable                officer.disable         disableOfficer
//   POST /edge/v1/officers/enable                 officer.disable         enableOfficer
//   POST /edge/v1/officers/sessions/revoke        officer.sessions.revoke revokeOfficerSessions
//   POST /edge/v1/auth/officer/activate           anonymous (CSRF)        activateOfficer
//
// → iam-service /v1/officers/** under the administrator's own credential.
// The agency is the session's; the target travels as `targetOfficerId`
// (`officerId` is a forbidden request field at this boundary — it names an
// actor). Bodies are exact-key; no write is retried by the edge.
//
// EVERY ANSWER IS REBUILT FROM AN ALLOWLIST. An officer row crosses with its
// id, handle, posts, status, activation state and timestamps only — never a
// credential, a code hash, or anything an upstream bug might add.
//
// FOUR-EYES (ADR-036 addendum): create and reissue NEVER carry an activation
// code, and their projection drops one even if an upstream bug sent it. The
// one-time code crosses exactly once, on releaseOfficerActivation, to a
// DIFFERENT administrator of the same agency, and is never logged here.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type RouteHandler } from '@usrp/shared-http';
import { UPSTREAM, type UpstreamOperation } from '../../domain/upstream-operations.js';
import { withAnonymous, withOfficerSession, type EdgeDeps } from './guards.js';
import { clientBucketKey, enforceRateLimit, targetBucketKey } from './rate-limit.js';
import { readJsonBody, requireBoundedString, requireUuid } from './validation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const CODE_RE = /^[A-HJ-NP-Z2-9]{5}(?:-[A-HJ-NP-Z2-9]{5}){3}$/;
const TOKEN_RE = /^[A-Z][A-Z_]{1,63}$/;
const POST_RE = /^[a-z][a-z_]{1,63}$/;
const STATUSES = new Set(['active', 'disabled', 'pending']);
const ACTIVATION_STATES = new Set(['PENDING_RELEASE', 'RELEASED']);
const CHANGE_OUTCOMES = new Set(['ASSIGNED', 'DISABLED', 'ENABLED', 'REVOKED', 'UNCHANGED']);
/** The upstream refusals that may cross, each with its own HTTP status. */
const REFUSALS: Readonly<Record<string, number>> = {
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
const MISMATCH: HttpResult = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
const MAX_PASSWORD = 256;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function instantOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
}

/** One officer row, rebuilt from the allowlist; null when off-contract. */
export function projectOfficer(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const posts = raw['posts'];
  if (
    typeof raw['officerId'] !== 'string' || !UUID_RE.test(raw['officerId']) ||
    typeof raw['loginHandle'] !== 'string' || !HANDLE_RE.test(raw['loginHandle']) ||
    !Array.isArray(posts) || !posts.every((p): p is string => typeof p === 'string' && POST_RE.test(p)) ||
    typeof raw['status'] !== 'string' || !STATUSES.has(raw['status']) ||
    typeof raw['createdAt'] !== 'string' || Number.isNaN(Date.parse(raw['createdAt'])) ||
    !instantOrNull(raw['activatedAt']) || !instantOrNull(raw['lastLoginAt']) ||
    !instantOrNull(raw['activationExpiresAt']) ||
    !(raw['activationState'] === null || (typeof raw['activationState'] === 'string' && ACTIVATION_STATES.has(raw['activationState']))) ||
    typeof raw['releasableByYou'] !== 'boolean'
  ) {
    return null;
  }
  return {
    officerId: raw['officerId'],
    loginHandle: raw['loginHandle'],
    posts: [...posts],
    status: raw['status'],
    createdAt: raw['createdAt'],
    activatedAt: raw['activatedAt'],
    lastLoginAt: raw['lastLoginAt'],
    activationExpiresAt: raw['activationExpiresAt'],
    activationState: raw['activationState'],
    releasableByYou: raw['releasableByYou'],
  };
}

/** The agency's officer list; null when any row is off-contract (never a partial relay). */
export function projectOfficerList(raw: unknown): HttpResult | null {
  if (!isRecord(raw) || !Array.isArray(raw['officers'])) return null;
  const officers: Record<string, unknown>[] = [];
  for (const row of raw['officers']) {
    const projected = projectOfficer(row);
    if (projected === null) return null;
    officers.push(projected);
  }
  return { status: 200, body: { officers } };
}

function refusal(status: number, raw: unknown): HttpResult | null {
  if (!isRecord(raw) || typeof raw['error'] !== 'string') return null;
  const expected = REFUSALS[raw['error']];
  return expected === status ? { status, body: { error: raw['error'] } } : null;
}

/**
 * create (201) / reissue (200): the officer and the outcome, NOTHING ELSE. An
 * `activation` object from upstream is dropped, never relayed: the creating or
 * reissuing administrator must never hold the code (four-eyes).
 */
export function projectCredentialIssue(status: number, raw: unknown, successStatus: 200 | 201): HttpResult | null {
  if (status === successStatus) {
    if (!isRecord(raw)) return null;
    const officer = projectOfficer(raw['officer']);
    const outcome = successStatus === 201 ? 'CREATED' : 'REISSUED';
    if (officer === null || raw['outcome'] !== outcome) return null;
    return { status: successStatus, body: { outcome, officer } };
  }
  return refusal(status, raw);
}

/** release (200): the officer plus the one-time code, to a different administrator, once. */
export function projectActivationRelease(status: number, raw: unknown): HttpResult | null {
  if (status === 200) {
    if (!isRecord(raw) || !isRecord(raw['activation'])) return null;
    const officer = projectOfficer(raw['officer']);
    const code = raw['activation']['code'];
    const expiresAt = raw['activation']['expiresAt'];
    if (officer === null || raw['outcome'] !== 'RELEASED' || typeof code !== 'string' || !CODE_RE.test(code) ||
        typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
      return null;
    }
    return { status: 200, body: { outcome: 'RELEASED', officer, activation: { code, expiresAt } } };
  }
  return refusal(status, raw);
}

/** posts / disable / enable / sessions-revoke. */
export function projectOfficerChange(status: number, raw: unknown): HttpResult | null {
  if (status === 200) {
    if (!isRecord(raw)) return null;
    const officer = projectOfficer(raw['officer']);
    const outcome = raw['outcome'];
    const revoked = raw['sessionsRevoked'];
    if (officer === null || typeof outcome !== 'string' || !CHANGE_OUTCOMES.has(outcome) ||
        typeof revoked !== 'number' || !Number.isInteger(revoked) || revoked < 0) {
      return null;
    }
    return { status: 200, body: { outcome, officer, sessionsRevoked: revoked } };
  }
  return refusal(status, raw);
}

function exactKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, 'INVALID_REQUEST', `Field "${key}" is not accepted.`);
  }
}

function requireReason(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Field "reasonCode" is required.');
  }
  return value;
}

function requirePosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16 ||
      !value.every((p): p is string => typeof p === 'string' && p.length <= 64)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Field "posts" must be a non-empty list of post names.');
  }
  return value;
}

/** Statuses every officer-admin call maps the same way before its own projection. */
function common(status: number): HttpResult | null {
  if (status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
  if (status === 401) return { status: 401, body: { reason: 'revoked' } };
  if (status === 503) return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
  return null;
}

function permissionDenied(raw: unknown): HttpResult | null {
  return isRecord(raw) && raw['error'] === 'PERMISSION_DENIED'
    ? { status: 403, body: { error: 'PERMISSION_DENIED' } }
    : null;
}

function changeHandler(
  deps: EdgeDeps,
  operationId: 'assignOfficerPosts' | 'disableOfficer' | 'enableOfficer' | 'revokeOfficerSessions',
  operation: UpstreamOperation,
  withPosts: boolean,
): RouteHandler {
  return withOfficerSession(deps, operationId, async (ctx, session) => {
    const body = await readJsonBody(ctx);
    exactKeys(body, withPosts ? ['targetOfficerId', 'posts', 'reasonCode'] : ['targetOfficerId', 'reasonCode']);
    const forwarded: Record<string, unknown> = {
      targetOfficerId: requireUuid(body['targetOfficerId'], 'targetOfficerId'),
      ...(withPosts ? { posts: requirePosts(body['posts']) } : {}),
      reasonCode: requireReason(body['reasonCode']),
    };
    const upstream = await deps.upstream.call({
      operation,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: forwarded,
    });
    return common(upstream.status) ??
      projectOfficerChange(upstream.status, upstream.body) ??
      (upstream.status === 403 ? permissionDenied(upstream.body) : null) ??
      MISMATCH;
  });
}

export function listOfficersHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'listOfficers', async (ctx, session) => {
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.officerList,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
    });
    const shared = common(upstream.status);
    if (shared !== null) return shared;
    if (upstream.status === 403) return permissionDenied(upstream.body) ?? MISMATCH;
    return upstream.status === 200 ? projectOfficerList(upstream.body) ?? MISMATCH : MISMATCH;
  });
}

export function createOfficerHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'createOfficer', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    exactKeys(body, ['loginHandle', 'posts']);
    const loginHandle = requireBoundedString(body['loginHandle'], 'loginHandle', 64);
    const posts = requirePosts(body['posts']);
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.officerCreate,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { loginHandle, posts },
    });
    return common(upstream.status) ??
      projectCredentialIssue(upstream.status, upstream.body, 201) ??
      (upstream.status === 403 ? permissionDenied(upstream.body) : null) ??
      MISMATCH;
  });
}

export function reissueOfficerActivationHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'reissueOfficerActivation', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    exactKeys(body, ['targetOfficerId']);
    const targetOfficerId = requireUuid(body['targetOfficerId'], 'targetOfficerId');
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.officerReissueActivation,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { targetOfficerId },
    });
    return common(upstream.status) ??
      projectCredentialIssue(upstream.status, upstream.body, 200) ??
      (upstream.status === 403 ? permissionDenied(upstream.body) : null) ??
      MISMATCH;
  });
}

export function releaseOfficerActivationHandler(deps: EdgeDeps): RouteHandler {
  return withOfficerSession(deps, 'releaseOfficerActivation', async (ctx, session) => {
    const body = await readJsonBody(ctx);
    exactKeys(body, ['targetOfficerId']);
    const targetOfficerId = requireUuid(body['targetOfficerId'], 'targetOfficerId');
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.officerReleaseActivation,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      body: { targetOfficerId },
    });
    return common(upstream.status) ??
      projectActivationRelease(upstream.status, upstream.body) ??
      (upstream.status === 403 ? permissionDenied(upstream.body) : null) ??
      MISMATCH;
  });
}

export function assignOfficerPostsHandler(deps: EdgeDeps): RouteHandler {
  return changeHandler(deps, 'assignOfficerPosts', UPSTREAM.officerAssignPosts, true);
}

export function disableOfficerHandler(deps: EdgeDeps): RouteHandler {
  return changeHandler(deps, 'disableOfficer', UPSTREAM.officerDisable, false);
}

export function enableOfficerHandler(deps: EdgeDeps): RouteHandler {
  return changeHandler(deps, 'enableOfficer', UPSTREAM.officerEnable, false);
}

export function revokeOfficerSessionsHandler(deps: EdgeDeps): RouteHandler {
  return changeHandler(deps, 'revokeOfficerSessions', UPSTREAM.officerRevokeSessions, false);
}

/**
 * Activation: anonymous, CSRF, rate-limited per handle and per client with
 * the login budget. Every rejection is one ACTIVATION_REJECTED; a too-short
 * password is the only distinguishable answer (WEAK_PASSWORD) and is decided
 * upstream before any lookup. 204 on success: the officer then signs in.
 */
export function activateOfficerHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'activateOfficer', async (ctx): Promise<HttpResult> => {
    const body = await readJsonBody(ctx);
    exactKeys(body, ['loginHandle', 'activationCode', 'password']);
    const loginHandle = requireBoundedString(body['loginHandle'], 'loginHandle', 64);
    const activationCode = requireBoundedString(body['activationCode'], 'activationCode', 64);
    const password = requireBoundedString(body['password'], 'password', MAX_PASSWORD);

    const limits = deps.config.rateLimits;
    await enforceRateLimit(
      deps.limiter,
      targetBucketKey(deps.config.session.handleHmacKey, 'activateOfficer', loginHandle.trim().toLowerCase()),
      limits.loginPerMinute,
    );
    await enforceRateLimit(
      deps.limiter,
      `${clientBucketKey(ctx, limits.trustedProxyHops)}:activateOfficer`,
      limits.loginPerMinute,
    );

    const upstream = await deps.upstream.call({
      operation: UPSTREAM.officerActivate,
      correlationId: ctx.correlationId,
      body: { loginHandle, activationCode, password },
    });
    if (upstream.status === 204) return { status: 204 };
    if (upstream.status === 400 && isRecord(upstream.body) && upstream.body['error'] === 'WEAK_PASSWORD') {
      return { status: 400, body: { error: 'WEAK_PASSWORD' } };
    }
    if (upstream.status === 400 || upstream.status === 401) {
      return { status: 401, body: { error: 'ACTIVATION_REJECTED' } };
    }
    if (upstream.status === 503) return { status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    return MISMATCH;
  });
}
