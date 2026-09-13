// ══════════════════════════════════════════════════════════════════
// edge-gateway — The walk-in lane (RDF only)
//
// THE WALK_IN_* STATUSES EXIST ONLY IN rdf_ops.application_status. rnp_ops and
// rcs_ops do not have them, which is why upstream compares `status::text` rather
// than casting to an enum. An RNP or RCS session here is a 403 — an
// authorization boundary — and the edge answers it from the SESSION AGENCY
// before spending an upstream round trip on a request that cannot succeed.
//
// IDENTITY IS RESOLVED SERVER-SIDE. The old frontend computed a
// `nationalIdHash` in the browser and sent it as an identity assertion: a
// 16-digit structured value has too little entropy for an unsalted hash to be a
// pseudonym, and a client-computed identity claim is one the client can
// fabricate. The edge takes the RAW National ID over TLS, resolves it against
// NIDA through identity-service, and forwards only the resulting opaque
// applicant id — which never travels back to the browser either.
//
// TWO UPSTREAM CALLS, ONE BROWSER OPERATION. That composition is exactly what an
// edge is for: the field officer's tablet asks one question ("register this
// person") instead of orchestrating a NIDA verification and a registration and
// holding an applicant key in between.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RequestContext, Route } from '@usrp/shared-http';
import { ALL_CATEGORIES } from '@usrp/shared-types';
import type { EdgeDeps } from './deps.js';
import { withOfficerSession, type OfficerEdgeSession } from './guard.js';
import { mapTransition } from './officer-transitions.controller.js';
import { EDGE_PATHS } from './paths.js';
import { codedError } from './responses.js';
import {
  containsForbiddenField,
  readApplicationId,
  readNationalId,
  readOptionalText,
} from './validate.js';

const CATEGORIES: ReadonlySet<string> = new Set(ALL_CATEGORIES);
const MAX_ACADEMIC_REF = 64;
const MAX_CATEGORY = 64;

export function walkInRoutes(deps: EdgeDeps): Route[] {
  return [
    {
      method: 'POST',
      path: EDGE_PATHS.walkInRegister,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          // Refused before any upstream call: the lane does not exist for them.
          if (session.agency !== 'RDF') return codedError(403, 'WALK_IN_NOT_AVAILABLE');

          const body = await ctx.json<unknown>();
          if (containsForbiddenField(body)) return codedError(400, 'FORBIDDEN_FIELD');
          const nationalId = readNationalId(body);
          if (nationalId === null) return codedError(400, 'INVALID_NATIONAL_ID');
          const category = readOptionalText(body, 'category', MAX_CATEGORY);
          if (!category.ok || category.value === null || !CATEGORIES.has(category.value)) {
            return codedError(422, 'INVALID_CATEGORY');
          }
          const nesa = readOptionalText(body, 'nesaIndexNumber', MAX_ACADEMIC_REF);
          const hec = readOptionalText(body, 'hecRegistrationNumber', MAX_ACADEMIC_REF);
          if (!nesa.ok || !hec.ok) return codedError(422, 'INVALID_ACADEMIC_REFERENCE');

          const upstreamCtx = { correlationId: ctx.correlationId };
          // Step 1 — establish WHO, against NIDA, with the officer's own
          // credential (ADR-012 D1 permits an officer on the brokered route).
          const identity = await deps.identity.verifyIdentity(
            session.credential,
            nationalId,
            'WALK_IN',
            upstreamCtx,
          );
          if (identity.kind === 'UNVERIFIED') {
            // The candidate is standing in front of the officer, so this is the
            // legitimate on-site lookup ADR-012 exists for — not an enumeration
            // channel: it needs an officer session, is rate limited, and the
            // unauthenticated citizen door (OTP) reveals nothing at all.
            return codedError(422, 'IDENTITY_NOT_VERIFIED');
          }

          // Step 2 — register. The applicant id stays server-side.
          const outcome = await deps.applications.registerWalkIn(
            session.credential,
            {
              applicantId: identity.applicantId,
              category: category.value,
              ...(nesa.value !== null ? { nesaIndexNumber: nesa.value } : {}),
              ...(hec.value !== null ? { hecRegistrationNumber: hec.value } : {}),
            },
            upstreamCtx,
          );

          switch (outcome.kind) {
            case 'REGISTERED':
              // `qrInvitationCode` is in the upstream body and is not carried:
              // it is a bearer credential for the venue, not a browser value.
              return {
                status: 201,
                body: { applicationId: outcome.applicationId, status: outcome.status },
              };
            case 'FORBIDDEN':
              return codedError(403, 'FORBIDDEN');
            case 'UNSUPPORTED_AGENCY':
              return codedError(403, 'WALK_IN_NOT_AVAILABLE');
            case 'NOT_FOUND':
              // The identity was verified a moment ago, so this is a genuine
              // upstream race, not a client error.
              return codedError(409, 'APPLICANT_NOT_AVAILABLE');
            case 'INVALID_INPUT':
              return codedError(422, outcome.reason);
            case 'CONFLICT':
              return codedError(409, outcome.reason);
            default:
              return assertNever(outcome);
          }
        },
      ),
    },
    {
      method: 'POST',
      path: EDGE_PATHS.walkInVet,
      handler: withOfficerSession(
        deps,
        async (ctx: RequestContext, session: OfficerEdgeSession): Promise<HttpResult> => {
          if (session.agency !== 'RDF') return codedError(403, 'WALK_IN_NOT_AVAILABLE');
          const body = await ctx.json<unknown>();
          if (containsForbiddenField(body)) return codedError(400, 'FORBIDDEN_FIELD');
          const applicationId = readApplicationId(body);
          if (applicationId === null) return codedError(400, 'INVALID_APPLICATION_ID');
          return mapTransition(
            applicationId,
            await deps.applications.vetWalkIn(session.credential, applicationId, {
              correlationId: ctx.correlationId,
            }),
          );
        },
      ),
    },
  ];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled walk-in outcome: ${JSON.stringify(value)}`);
}
