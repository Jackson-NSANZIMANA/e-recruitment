// ══════════════════════════════════════════════════════════════════
// @usrp/shared-auth — HTTP enforcement seam (the adapter-layer wrapper)
//
// @usrp/shared-http is deliberately a "moves bytes at the edge" substrate
// with no middleware concept. Authorization — which principal-kind may call
// which route — is policy, so it lives here as a higher-order function that
// wraps a handler at the point of route assembly. shared-http never learns
// about auth or crypto: the verifier is an injected `(headers) => Principal
// | null`, and the verified Principal reaches the inner handler as a second
// argument (no change to RequestContext / RouteHandler).
// ══════════════════════════════════════════════════════════════════

import type { IncomingHttpHeaders } from 'node:http';
import { HttpError, type HttpResult, type RequestContext, type RouteHandler } from '@usrp/shared-http';
import { verifyAuthToken } from './token.js';
import type { PrincipalKind } from './claims.js';
import type { Principal } from './principal.js';

/** A route handler that also receives the verified caller. */
export type AuthedHandler = (
  ctx: RequestContext,
  principal: Principal,
) => Promise<HttpResult> | HttpResult;

/** Verifies request headers into a trusted Principal, or null to reject. */
export type AuthVerifier = (headers: IncomingHttpHeaders) => Principal | null;

/** What kind(s) of principal a route requires. A single kind is the common
 *  case; a list means ANY of the listed kinds is acceptable (e.g. the identity
 *  verify front door serves both the system-internal path and the walk-in
 *  field officer's on-site NIDA lookup). */
export interface PrincipalRequirement {
  readonly kind: PrincipalKind | readonly PrincipalKind[];
}

export interface AuthVerifierConfig {
  readonly publicKeyPem: string;
  readonly issuer: string;
  readonly audience: string;
  /** Clock injection for tests; defaults to the current time per request. */
  readonly now?: () => Date;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Extract the bearer token from an Authorization header (case-insensitive). */
function bearerToken(headers: IncomingHttpHeaders): string | null {
  const raw = firstHeader(headers.authorization)?.trim();
  if (raw === undefined || raw.length === 0) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(raw);
  if (match === null) return null;
  const token = match[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/** Build a verifier that reads `Authorization: Bearer <token>` and validates it. */
export function makeAuthVerifier(config: AuthVerifierConfig): AuthVerifier {
  return (headers: IncomingHttpHeaders): Principal | null => {
    const token = bearerToken(headers);
    if (token === null) return null;
    return verifyAuthToken(config.publicKeyPem, token, {
      now: (config.now ?? (() => new Date()))(),
      expectedIssuer: config.issuer,
      expectedAudience: config.audience,
    });
  };
}

/**
 * Wrap an AuthedHandler into a plain RouteHandler: 401 when no valid
 * principal is present, 403 when the principal is the wrong kind, otherwise
 * the handler runs with the verified Principal. HttpError already renders
 * 401/403 via the shared-http error mapper.
 */
export function withAuth(
  verify: AuthVerifier,
  require: PrincipalRequirement,
  handler: AuthedHandler,
): RouteHandler {
  return (ctx: RequestContext): Promise<HttpResult> | HttpResult => {
    const principal = verify(ctx.headers);
    if (principal === null) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'A valid bearer token is required.');
    }
    const allowed: readonly PrincipalKind[] = Array.isArray(require.kind)
      ? require.kind
      : [require.kind as PrincipalKind];
    if (!allowed.includes(principal.kind)) {
      throw new HttpError(403, 'FORBIDDEN', `This route requires a ${allowed.join(' or ')} principal.`);
    }
    return handler(ctx, principal);
  };
}
