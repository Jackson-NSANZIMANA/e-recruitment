// ══════════════════════════════════════════════════════════════════
// edge-gateway — Upstream transition body → TransitionOutcome
//
// One translator for the four officer transitions, the two walk-in writes and
// the citizen withdrawal, because upstream answers all of them in the same
// vocabulary of outcomes.
//
// THE ONE LINE THAT MATTERS MOST IN THIS FILE is the CROSS_AGENCY_LOCKED case:
// upstream reports `lockedByAgency` because an officer-facing microservice can,
// and the edge DROPS it. Naming the agency that holds the ADR-014 accept lock
// tells an RDF officer that RNP has accepted this citizen — a fact about a
// sibling agency's processing that FORCE'd RLS spends real effort hiding. The
// value is discarded at the boundary, not "not rendered" by a UI, so no future
// component can put it back.
// ══════════════════════════════════════════════════════════════════

import { UpstreamError } from '../../domain/errors.js';
import type { TransitionOutcome } from '../../ports/upstream.js';
import { readString, type UpstreamResponse } from './http-json.js';

export function toTransitionOutcome(response: UpstreamResponse): TransitionOutcome {
  const status = readString(response.body, 'status');

  if (response.status === 200) {
    if (status === 'APPLIED') {
      const toStatus = readString(response.body, 'toStatus');
      if (toStatus === null) {
        throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'APPLIED outcome carried no toStatus');
      }
      return { kind: 'APPLIED', toStatus };
    }
    if (status === 'WITHDRAWN') {
      // The citizen's own withdrawal (ADR-020). The resulting status IS the
      // outcome name; `agency` and `fromStatus` are not carried because
      // TransitionResult is { applicationId, status } and callers re-read.
      return { kind: 'APPLIED', toStatus: 'WITHDRAWN' };
    }
    if (status === 'NO_CHANGE') {
      return {
        kind: 'NO_CHANGE',
        currentStatus: readString(response.body, 'currentStatus') ?? 'UNKNOWN',
      };
    }
  }

  if (response.status === 403) return { kind: 'FORBIDDEN' };

  // 501 UNSUPPORTED_AGENCY: only rdf_ops models the WALK_IN_* statuses, so an
  // RNP or RCS officer on a walk-in route is asking for something that does not
  // exist for them. The edge answers 403 (see the controller) — it is an
  // authorization boundary, not a broken request.
  if (response.status === 501 || status === 'UNSUPPORTED_AGENCY') {
    return { kind: 'UNSUPPORTED_AGENCY' };
  }

  if (response.status === 404) return { kind: 'NOT_FOUND' };

  if (response.status === 409) {
    if (status === 'CROSS_AGENCY_LOCKED') {
      // `lockedByAgency` IS PRESENT IN response.body AND IS NOT READ. See header.
      return { kind: 'ACCEPT_LOCKED' };
    }
    if (status === 'AGE_PENDING') {
      return {
        kind: 'AGE_PENDING',
        currentStatus: readString(response.body, 'currentStatus') ?? 'UNKNOWN',
      };
    }
    return {
      kind: 'NOT_APPLICABLE',
      currentStatus: readString(response.body, 'currentStatus') ?? status ?? 'UNKNOWN',
    };
  }

  if (response.status === 422) {
    // reason names WHICH rule failed (agency medical mode, category/agency
    // mismatch, missing academic input). Machine-readable, never a raw upstream
    // message, and it identifies no person.
    return {
      kind: 'INVALID_INPUT',
      reason: readString(response.body, 'reason') ?? status ?? 'INVALID_INPUT',
    };
  }

  if (response.status === 400) {
    return { kind: 'INVALID_INPUT', reason: readString(response.body, 'error') ?? 'INVALID_REQUEST' };
  }

  throw new UpstreamError(
    'UPSTREAM_UNAVAILABLE',
    `Unmapped upstream transition response (${response.status})`,
  );
}
