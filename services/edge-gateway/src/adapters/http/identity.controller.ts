// ══════════════════════════════════════════════════════════════════
// edge-gateway — The ONE brokered service-internal route
//
// `verifyIdentity` is marked service-internal in the contract; ADR-012 D1
// widened upstream's `withAuth` to accept officer principals on it so a field
// officer can establish a walk-in candidate's identity with a tablet online.
// It is named in exactly one place here — BROKERED_OPERATIONS in paths.ts — so
// the exception is an auditable line of code rather than a permissive rule
// about what an edge may proxy.
//
// OFFICER SESSION ONLY, DELIBERATELY NOT REACHABLE BY A CITIZEN. An
// unauthenticated or citizen-reachable NIDA check is a national identity
// enumeration oracle. Citizens authenticate by OTP instead, where the 202
// reveals nothing.
//
// AND IT RETURNS ONLY `{ verified }`. Two things the draft contract expected are
// NOT here and cannot be:
//   • `fullName` — identity-service never returns a name. Its verify controller
//     exposes the opaque applicant UUID and nothing else, on purpose: "the raw
//     National ID is request-only … the edge gets only the opaque applicant
//     UUID". There is no upstream read that would produce a verified name, so
//     promising one in a response schema is how a UI ends up rendering
//     `undefined` to an officer.
//   • `applicantId` — it is resolved and used server-side (the walk-in flow) and
//     never sent onward. The officer console identifies people by processing
//     code; every officer read in the platform omits the applicant key for the
//     same reason.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RequestContext, Route } from '@usrp/shared-http';
import { toPlatformChannel } from './channel.js';
import type { EdgeDeps } from './deps.js';
import { withOfficerSession, type OfficerEdgeSession } from './guard.js';
import { EDGE_PATHS } from './paths.js';
import { codedError, rateLimited } from './responses.js';
import { containsForbiddenField, readNationalId } from './validate.js';

export function identityRoutes(deps: EdgeDeps): Route[] {
  return [
    {
      method: 'POST',
      path: EDGE_PATHS.verifyIdentity,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          const body = await ctx.json<unknown>();
          if (containsForbiddenField(body)) return codedError(400, 'FORBIDDEN_FIELD');
          const nationalId = readNationalId(body);
          if (nationalId === null) return codedError(400, 'INVALID_NATIONAL_ID');
          const rawChannel =
            typeof body === 'object' && body !== null
              ? (body as Record<string, unknown>)['channel']
              : undefined;
          const channel = toPlatformChannel(rawChannel);
          if (channel === null) return codedError(400, 'INVALID_CHANNEL');

          // Rate limited PER OFFICER as well as per address: an authenticated
          // oracle is still an oracle, and the officer's token subject is the
          // only stable identity available here.
          if (!deps.limiter.allow(EDGE_PATHS.verifyIdentity, ctx.headers, session.subjectId)) {
            return rateLimited();
          }

          const outcome = await deps.identity.verifyIdentity(
            session.credential,
            nationalId,
            channel,
            { correlationId: ctx.correlationId },
          );
          // The submitted identifier is never echoed. `verified` is the whole
          // answer the officer asked for.
          return { status: 200, body: { verified: outcome.kind === 'VERIFIED' } };
        },
      ),
    },
  ];
}
