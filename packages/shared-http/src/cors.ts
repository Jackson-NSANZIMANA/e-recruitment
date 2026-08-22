// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — CORS policy resolution
//
// CORS_ORIGINS has been in .env.example since day one with NOTHING reading
// it. It becomes load-bearing the moment a browser talks to the edge tier, so
// it lives in the transport where no route can forget it.
//
// Two properties this file exists to guarantee:
//
//   1. NEVER `Access-Control-Allow-Origin: *`. The edge is credentialed by
//      design (the whole point is a cookie the browser cannot read), and the
//      spec forbids the wildcard alongside Allow-Credentials: true. Browsers
//      enforce it, so a wildcard here would break the product, not just the
//      security model. The allowed origin is echoed back EXACTLY, from an
//      allow-list, after an exact string match — no substring or suffix
//      matching, which is how `evil-gov.rw.attacker.com` gets in.
//
//   2. ALWAYS `Vary: Origin`, INCLUDING on a rejected origin. Without it a
//      shared cache can be poisoned into replaying one origin's ACAO header
//      to a different origin.
//
// Preflight is answered by the transport itself and never reaches a route, so
// an OPTIONS handler can never be forgotten on a new endpoint.
// ══════════════════════════════════════════════════════════════════

import type { CorsPolicy } from './types.js';

/**
 * Request headers a browser may send. `x-csrf-token` is here because the edge
 * CSRF defence is a double-submit echo (see the BFF slice); `authorization` is
 * kept for the internal service-to-service callers that share this substrate.
 */
const DEFAULT_ALLOWED_HEADERS: readonly string[] = [
  'content-type',
  'authorization',
  'x-csrf-token',
  'x-correlation-id',
];

const DEFAULT_ALLOWED_METHODS: readonly string[] = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];

/** Response headers JS is allowed to read — the correlation pair, for support. */
const DEFAULT_EXPOSED_HEADERS: readonly string[] = ['x-request-id', 'x-correlation-id'];

/** 10 minutes. Long enough to matter, short enough that a policy fix lands. */
const DEFAULT_PREFLIGHT_MAX_AGE_SECONDS = 600;

/** Exact-match allow-list check. No prefix/suffix/substring matching, ever. */
export function isAllowedOrigin(policy: CorsPolicy, origin: string | undefined): boolean {
  if (origin === undefined || origin.length === 0) return false;
  return policy.origins.includes(origin);
}

/** CORS headers for a normal (non-preflight) response from an allowed origin. */
export function corsResponseHeaders(policy: CorsPolicy, origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    'access-control-allow-origin': origin,
    vary: 'Origin',
  };
  if (policy.credentials === true) {
    headers['access-control-allow-credentials'] = 'true';
  }
  const exposed = policy.exposedHeaders ?? DEFAULT_EXPOSED_HEADERS;
  if (exposed.length > 0) {
    headers['access-control-expose-headers'] = exposed.join(', ');
  }
  return headers;
}

/** CORS headers for a preflight (OPTIONS) response from an allowed origin. */
export function corsPreflightHeaders(policy: CorsPolicy, origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...corsResponseHeaders(policy, origin),
    'access-control-allow-methods': (policy.allowedMethods ?? DEFAULT_ALLOWED_METHODS).join(', '),
    'access-control-allow-headers': (policy.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS).join(', '),
    'access-control-max-age': String(policy.preflightMaxAgeSeconds ?? DEFAULT_PREFLIGHT_MAX_AGE_SECONDS),
  };
  // A preflight response varies on the request-headers/method probe too.
  headers['vary'] = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';
  return headers;
}
