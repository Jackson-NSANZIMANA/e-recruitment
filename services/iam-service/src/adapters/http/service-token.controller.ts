// ══════════════════════════════════════════════════════════════════
// iam-service — HTTP ingress for service-token issuance (client-credentials)
//
// The second (and only other) UNauthenticated route in the platform's authed
// surface — like login, it is what mints the token, so it cannot itself
// require one. It takes { clientId, clientSecret } and returns
// { token, expiresAt } on success.
//
//   POST /v1/auth/service/token  {clientId, clientSecret}  →  200 {token, expiresAt}
//
// A generic 401 INVALID_CLIENT covers unknown client, wrong secret, AND
// disabled client (no enumeration). The secret is NEVER echoed, logged, or
// placed in an error. Malformed input → 400 (a shape error, not a signal
// about whether the client exists).
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import type { ServiceTokenService } from '../../application/service-token.service.js';

export const SERVICE_TOKEN_PATH = '/v1/auth/service/token';

// Generous upper bounds — reject absurd inputs without leaking policy.
const MAX_CLIENT_ID = 128; // matches service_accounts.client_id varchar(128)
const MAX_SECRET = 256;

interface TokenBody {
  readonly clientId?: unknown;
  readonly clientSecret?: unknown;
}

/** The single service-token route, bound to the use case. */
export function serviceTokenRoutes(service: ServiceTokenService): Route[] {
  return [
    {
      method: 'POST',
      path: SERVICE_TOKEN_PATH,
      handler: async (ctx): Promise<HttpResult> => {
        const body = await ctx.json<TokenBody>();
        const { clientId, clientSecret } = body;

        if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > MAX_CLIENT_ID) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "clientId" is required.');
        }
        if (typeof clientSecret !== 'string' || clientSecret.length === 0 || clientSecret.length > MAX_SECRET) {
          throw new HttpError(400, 'INVALID_REQUEST', 'Field "clientSecret" is required.');
        }

        const outcome = await service.issue({
          clientId,
          clientSecret,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });

        if (outcome.kind === 'INVALID_CLIENT') {
          throw new HttpError(401, 'INVALID_CLIENT', 'Invalid client id or secret.');
        }
        return { status: 200, body: { token: outcome.token, expiresAt: outcome.expiresAt } };
      },
    },
  ];
}
