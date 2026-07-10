// ══════════════════════════════════════════════════════════════════
// @usrp/shared-auth — Wire claim set for USRP bearer tokens
//
// The signed, PII-free payload carried inside a USRP-AUTH token. Kept
// deliberately small: an opaque subject id, the principal kind, and (for
// officers) the owning agency — never a name, NID, email, or any PII. The
// token is transported in the `Authorization: Bearer <token>` header and
// verified by every service with the issuer's PUBLIC key alone.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

export const AUTH_NS = 'USRP-AUTH';
export const AUTH_VER = 'v1';

/** The kind of caller a token represents. */
export type PrincipalKind = 'officer' | 'system';

/**
 * The claims signed into a token. PII-free by construction: `sub` is an
 * opaque id, never a human-readable identifier. `agency` is present iff
 * `kind === 'officer'` (omitted entirely for system tokens — never set to
 * undefined, per exactOptionalPropertyTypes).
 */
export interface AuthTokenClaims {
  readonly v: 1;
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly kind: PrincipalKind;
  readonly agency?: Agency;
  readonly roles?: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}
