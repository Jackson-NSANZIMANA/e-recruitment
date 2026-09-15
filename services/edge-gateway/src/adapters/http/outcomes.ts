// ══════════════════════════════════════════════════════════════════
// edge-gateway — Upstream outcome → browser response
//
// The upstream services answer with a `status` STRING in the body plus an HTTP
// code. Those bodies are internal vocabulary; some of them must not survive the
// boundary unchanged. This file is the one place that decides.
//
// FOUR MAPPINGS THAT ARE SECURITY DECISIONS, NOT TIDYING:
//
//   • 404 → a BARE body, byte-identical for a nonexistent id and for a sibling
//     agency's real one. If the two differed, an officer could walk ids to learn
//     what another agency is processing. Proven upstream; preserved here.
//   • CROSS_AGENCY_LOCKED loses `lockedByAgency`. ADR-014's lock is real, but
//     naming the holding agency discloses a sibling agency's caseload to an
//     officer with no authority to see it.
//   • 501 UNSUPPORTED_AGENCY → 403. Walk-in exists only in rdf_ops; an RNP or
//     RCS officer calling it is not authorized, which is a 403. A 501 would tell
//     the SPA "retry later, this is a server gap" about a permanent condition.
//   • 409 AGE_PENDING and 409 NO_CONFLICT are PRESERVED verbatim. They are the
//     two officer-visible states the field tablet acts on: AGE_PENDING means
//     "retry in a moment", NO_CONFLICT means "nothing to adjudicate". Collapsing
//     them into a generic conflict would break the walk-in and field-sync flows.
// ══════════════════════════════════════════════════════════════════

import type { HttpResult } from '@usrp/shared-http';
import { field, projectTransition } from './projections.js';

/** The bare 404. Never enriched — the correlation id is how you debug it. */
export const NOT_FOUND: HttpResult = { status: 404, body: { error: 'NOT_FOUND' } };

/**
 * ONE failure for every credential problem: unknown handle, wrong password,
 * disabled account, wrong OTP, expired OTP. The frontend's AuthAttempt type has
 * a single bare `rejected` case with no detail field, so it physically cannot
 * render a message that distinguishes them — and adding a code here would
 * re-enable account enumeration.
 */
export const CREDENTIAL_REJECTED: HttpResult = {
  status: 401,
  body: { error: 'CREDENTIAL_REJECTED' },
};

export const FORBIDDEN: HttpResult = { status: 403, body: { error: 'FORBIDDEN' } };

/** Walk-in is an rdf_ops-only lane. Permanent, not a gap: 403, not 501. */
export const UNSUPPORTED_AGENCY: HttpResult = {
  status: 403,
  body: { error: 'UNSUPPORTED_AGENCY' },
};

function statusOf(body: unknown): string | null {
  const value = field(body, 'status');
  return typeof value === 'string' ? value : null;
}

function currentStatusOf(body: unknown): string | null {
  const value = field(body, 'currentStatus');
  return typeof value === 'string' ? value : null;
}

/**
 * Map a 409 from any transition-shaped upstream route.
 *
 * `AGE_PENDING` and `NO_CONFLICT` keep their identity. Everything else becomes
 * ILLEGAL_TRANSITION, and CROSS_AGENCY_LOCKED loses the agency name.
 */
export function conflictResult(body: unknown): HttpResult {
  const upstreamStatus = statusOf(body);
  switch (upstreamStatus) {
    case 'AGE_PENDING':
      return {
        status: 409,
        body: { error: 'AGE_PENDING', status: currentStatusOf(body) },
      };
    case 'NO_CONFLICT':
      return { status: 409, body: { error: 'NO_CONFLICT' } };
    case 'CROSS_AGENCY_LOCKED':
      // Deliberately NO lockedByAgency. See the file header.
      return { status: 409, body: { error: 'CROSS_AGENCY_ACCEPT_LOCK' } };
    case 'IDENTITY_NOT_VERIFIED':
      return { status: 409, body: { error: 'IDENTITY_NOT_VERIFIED' } };
    case 'NO_WALK_IN_CAMPAIGN':
      // The upstream body names the agency; it is the officer's OWN agency, so
      // it is redundant rather than sensitive. Dropped for shape consistency.
      return { status: 409, body: { error: 'NO_WALK_IN_CAMPAIGN' } };
    default:
      return {
        status: 409,
        body: { error: 'ILLEGAL_TRANSITION', status: currentStatusOf(body) },
      };
  }
}

/**
 * Map a 422. The upstream `reason` on INVALID_MEDICAL_INPUT names which medical
 * mode the officer's agency uses (ADR-013) — operator-facing, PII-free, and the
 * only way a console can tell the officer what to send instead. Carried as
 * `detail`, which the contract marks never-render-to-a-user.
 */
export function validationResult(body: unknown): HttpResult {
  const upstreamStatus = statusOf(body) ?? 'VALIDATION_FAILED';
  const reason = field(body, 'reason');
  return {
    status: 422,
    body: {
      error: upstreamStatus,
      ...(typeof reason === 'string' ? { detail: reason } : {}),
    },
  };
}

/**
 * The shared outcome mapper for the four transitions, walk-in vetting and
 * citizen withdrawal — every route whose upstream answers with the
 * APPLIED / NO_CHANGE / NOT_APPLICABLE / NOT_FOUND / FORBIDDEN union.
 */
export function transitionResult(
  applicationId: string,
  status: number,
  body: unknown,
): HttpResult {
  if (status === 200) {
    return { status: 200, body: projectTransition(applicationId, body) };
  }
  if (status === 404) return NOT_FOUND;
  if (status === 403) return FORBIDDEN;
  if (status === 501) return UNSUPPORTED_AGENCY;
  if (status === 409) return conflictResult(body);
  if (status === 422) return validationResult(body);
  if (status === 400) {
    // The edge validated the shape before forwarding, so a 400 here means the
    // edge and the upstream disagree about the contract — a wiring bug, not a
    // caller error. It is surfaced as 422 with no upstream text.
    return { status: 422, body: { error: 'VALIDATION_FAILED' } };
  }
  return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
}
