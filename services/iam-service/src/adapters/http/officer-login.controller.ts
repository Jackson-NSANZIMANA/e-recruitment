// ══════════════════════════════════════════════════════════════════
// iam-service — HTTP ingress for officer login
//
// The ONE public (UNauthenticated) route in the platform's authed surface —
// login is what mints the token, so it cannot itself require one. It takes
// { loginHandle, password } and returns { token, expiresAt } on success.
//
//   POST /v1/auth/officer/login  {loginHandle, password}  →  200 {token, expiresAt}
//
// A generic 401 INVALID_CREDENTIALS covers unknown handle, wrong password, AND
// disabled account (no user-enumeration). The password is NEVER echoed, logged,
// or placed in an error. Malformed input → 400 (a shape error, not a signal
// about whether the handle exists).
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import type { OfficerLoginService } from '../../application/officer-login.service.js';

export const OFFICER_LOGIN_PATH = '/v1/auth/officer/login';

// Generous upper bounds — reject absurd inputs without leaking policy.
const MAX_HANDLE = 128; // matches officer_accounts.login_handle varchar(128)
const MAX_PASSWORD = 256;

interface LoginBody {
  readonly loginHandle?: unknown;
  readonly password?: unknown;
}

/** The single officer-login route, bound to the use case. */
export function officerLoginRoutes(service: OfficerLoginService): Route[] {
  return [
    {
      method: 'POST',
      path: OFFICER_LOGIN_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const body = await ctx.json<LoginBody>();
        const { loginHandle, password } = body;

        if (typeof loginHandle !== 'string' || loginHandle.length === 0 || loginHandle.length > MAX_HANDLE) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "loginHandle" is required.');
        }
        if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "password" is required.');
        }

        const outcome = await service.login({
          loginHandle,
          password,
          // An HTTP-originated action seeds the causal chain from its correlation id.
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });

        if (outcome.kind === 'INVALID_CREDENTIALS') {
          throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid handle or password.');
        }
        return { status: 200, body: { token: outcome.token, expiresAt: outcome.expiresAt } };
      },
    },
  ];
}
