// ══════════════════════════════════════════════════════════════════
// @usrp/shared-auth — Public API
//
// Human authentication for USRP: Ed25519 bearer tokens, the verified
// Principal, the pure principal→DB-role policy, and the HTTP enforcement
// wrapper. Zero runtime dependencies (crypto via @usrp/shared-security).
// This package never reads config — keys/issuer/audience are passed in.
// ══════════════════════════════════════════════════════════════════

export { AUTH_NS, AUTH_VER, type AuthTokenClaims, type PrincipalKind } from './claims.js';

export { dbRoleForPrincipal, type DbRole, type Principal } from './principal.js';

export { signAuthToken, verifyAuthToken, type VerifyAuthTokenOptions } from './token.js';

export {
  makeAuthVerifier,
  withAuth,
  type AuthedHandler,
  type AuthVerifier,
  type AuthVerifierConfig,
  type PrincipalRequirement,
} from './http.js';
