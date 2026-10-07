// ══════════════════════════════════════════════════════════════════
// @usrp/shared-auth — Ed25519 bearer token (mint + verify)
//
// A compact, self-contained, offline-verifiable auth credential. Format
// (JWS-like but zero-dep and Ed25519-only), mirroring the signed slot
// invitation (ADR-009):
//
//   USRP-AUTH.v1.<base64url(canonicalJson(claims))>.<base64url(ed25519 sig)>
//
// The signature covers "USRP-AUTH.v1.<payload>" so the header is bound too.
// The issuer holds the private key; every service verifies with the PUBLIC
// key alone — no DB round-trip. verifyAuthToken NEVER throws (any failure →
// null) so callers treat null as "reject".
// ══════════════════════════════════════════════════════════════════

import { AGENCIES, type Agency } from '@usrp/shared-types';
import { canonicalJson, signEd25519, verifyEd25519, type JsonValue } from '@usrp/shared-security';
import { AUTH_NS, AUTH_VER, type AuthTokenClaims } from './claims.js';
import type { Principal } from './principal.js';

/** Mint a signed, URL-safe bearer token from claims. */
export function signAuthToken(privateKeyPem: string, claims: AuthTokenClaims): string {
  const payload = Buffer.from(canonicalJson(claims as unknown as JsonValue), 'utf8').toString(
    'base64url',
  );
  const signingInput = `${AUTH_NS}.${AUTH_VER}.${payload}`;
  // signEd25519 returns base64; re-encode the raw signature bytes as base64url.
  const signatureUrl = Buffer.from(
    signEd25519(privateKeyPem, Buffer.from(signingInput, 'utf8')),
    'base64',
  ).toString('base64url');
  return `${signingInput}.${signatureUrl}`;
}

export interface VerifyAuthTokenOptions {
  /** Clock used for the expiry check. Defaults to the current time. */
  readonly now?: Date;
  /** If set, the token's `iss` must match exactly. */
  readonly expectedIssuer?: string;
  /** If set, the token's `aud` must match exactly. */
  readonly expectedAudience?: string;
}

function isAgency(value: unknown): value is Agency {
  return typeof value === 'string' && (AGENCIES as readonly string[]).includes(value);
}

/**
 * A parsed-but-unverified token payload: the KEYS AuthTokenClaims defines, with
 * every value still `unknown`. Deliberately not `AuthTokenClaims` — see the
 * comment at the JSON.parse call site in verifyAuthToken.
 */
type UnverifiedClaims = { readonly [K in keyof AuthTokenClaims]?: unknown };

/**
 * Verify a bearer token and return the trusted Principal, or null. Rejects
 * (→ null, never throws) on: malformed structure, wrong namespace/version,
 * bad signature, expired, issuer/audience mismatch, or a claim shape that
 * does not form a valid Principal (e.g. an officer without a real Agency).
 */
export function verifyAuthToken(
  publicKeyPem: string,
  token: string,
  options: VerifyAuthTokenOptions = {},
): Principal | null {
  try {
    // The namespace itself contains a '.', so a valid token is exactly 4 parts:
    // "USRP-AUTH" . "v1" . <payload> . <signature>.
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [ns, ver, payload, signatureUrl] = parts as [string, string, string, string];
    if (ns !== AUTH_NS || ver !== AUTH_VER) return null;

    const signingInput = `${ns}.${ver}.${payload}`;
    const signatureB64 = Buffer.from(signatureUrl, 'base64url').toString('base64');
    if (!verifyEd25519(publicKeyPem, Buffer.from(signingInput, 'utf8'), signatureB64)) {
      return null;
    }

    // UNTRUSTED. The signature proves the payload came from the issuer; it
    // proves NOTHING about its shape. This used to be cast straight to
    // AuthTokenClaims, which told the compiler that `v` was literally 1 and
    // `kind` was a PrincipalKind before a single byte had been checked — so
    // the real validation below read as dead code (and the linter correctly
    // said so: "comparison is always false, since 1 !== 1"). Parsing into
    // UnverifiedClaims keeps every field at `unknown` until it is checked,
    // which makes these guards mean to the type system what they always
    // meant at runtime.
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as UnverifiedClaims;

    if (claims.v !== 1) return null;
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;
    if (options.expectedIssuer !== undefined && claims.iss !== options.expectedIssuer) return null;
    if (options.expectedAudience !== undefined && claims.aud !== options.expectedAudience) {
      return null;
    }

    // Previously `Date.parse(claims.expiresAt)` on an unchecked value: a token
    // with a numeric or missing expiresAt reached Date.parse and relied on NaN
    // to fail closed. Checked explicitly now — same verdict, stated.
    if (typeof claims.expiresAt !== 'string') return null;
    const expiresAtMs = Date.parse(claims.expiresAt);
    if (Number.isNaN(expiresAtMs)) return null;
    const nowMs = (options.now ?? new Date()).getTime();
    if (expiresAtMs <= nowMs) return null;

    return toPrincipal(claims, claims.sub);
  } catch {
    return null;
  }
}

/**
 * Build a Principal from UNVERIFIED claims, or null on any shape violation.
 * `subjectId` is passed separately because the caller has already proven it is
 * a non-empty string; everything else is validated here.
 */
function toPrincipal(claims: UnverifiedClaims, subjectId: string): Principal | null {
  if (claims.kind === 'system') {
    return { kind: 'system', subjectId };
  }
  if (claims.kind === 'officer') {
    if (!isAgency(claims.agency)) return null;
    const roles = toRoles(claims.roles);
    if (roles === null) return null;
    return { kind: 'officer', subjectId, agency: claims.agency, roles };
  }
  return null;
}

/**
 * `roles` is optional; when present it must be an array of strings. An absent
 * value yields the empty list (what `claims.roles ?? []` did), but a malformed
 * one now REJECTS the token instead of being cast into a Principal — a role
 * list is an authorisation input, so a wrong-shaped one must not pass.
 */
function toRoles(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const roles: unknown[] = value;
  return roles.every((role): role is string => typeof role === 'string') ? roles : null;
}
