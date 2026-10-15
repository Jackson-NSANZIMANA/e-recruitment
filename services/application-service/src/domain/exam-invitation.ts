// ══════════════════════════════════════════════════════════════════
// application-service — Exam invitation (pure domain, ADR-033)
//
// WHEN may a citizen hold the QR they will present at the physical screening?
//
// The QR is the signed slot invitation (ADR-009): it names the venue and the
// exam day and is verified offline at the gate. It therefore exists only once a
// slot is ASSIGNED — which happens automatically the moment the three
// eligibility gates (age, academic, criminal) all pass. Before that there is
// nothing truthful to put in it: no venue, no date, and no eligibility.
// Handing out an "admission" QR at bare submission would let an applicant who
// later fails vetting walk up to a gate with a credential.
//
//   READY        SLOT_ASSIGNED / PHYSICAL_TEST_SCHEDULED, token present, not
//                expired, not yet used → the QR.
//   ADMITTED     the QR was spent at the venue gate (BUILD-003, ADR-034). It is
//                single-use, so it is never shown again: re-displaying a spent
//                credential only invites a second presentation.
//   PENDING      still being vetted (or green and awaiting a slot).
//   ON_HOLD      ADJUDICATION_REVIEW — a late hold: the invitation is withheld
//                until an officer clears it.
//   COMPLETED    the examination stage is behind the applicant.
//   CLOSED       rejected / withdrawn — no invitation.
//   EXPIRED      the exam day has passed.
//   WALK_IN      RDF walk-in lane: registered and admitted on site on exam
//                day (ADR-012) — there is no invitation to hold.
//   UNAVAILABLE  assigned, but no stored token (pre-ADR-033 assignment, or a
//                token that does not belong to this application).
//
// PURE: no I/O. `now` is injected.
// ══════════════════════════════════════════════════════════════════

import type { ApplicationStatus } from '@usrp/shared-types';

export type InvitationState =
  | 'READY'
  | 'ADMITTED'
  | 'PENDING'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'CLOSED'
  | 'EXPIRED'
  | 'UNAVAILABLE'
  | 'WALK_IN';

/** The claims the portal may show next to the QR — all PII-free (ADR-009). */
export interface InvitationClaimsView {
  readonly ticketId: string;
  readonly applicationId: string;
  readonly venueName: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  readonly expiresAt: string;
}

const READY_STATUSES: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'SLOT_ASSIGNED',
  'PHYSICAL_TEST_SCHEDULED',
]);
const PENDING_STATUSES: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'DRAFT',
  'SUBMITTED',
  'ACADEMIC_VETTING',
  'CRIMINAL_CLEARANCE',
  'DOCUMENT_REVIEW_GREEN',
  'DOCUMENT_REVIEW_AMBER',
]);
const WALK_IN_STATUSES: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'WALK_IN_REGISTERED',
  'WALK_IN_ON_SITE_VETTING',
  'WALK_IN_PHYSICAL_TEST',
]);
const COMPLETED_STATUSES: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'PHYSICAL_TEST_COMPLETE',
  'MEDICAL_REVIEW',
  'FINAL_SHORTLIST',
  'ACCEPTED',
]);

/**
 * Read the claims of a stored token WITHOUT verifying its signature. The token
 * is ours (written by the slot projection from scheduling's signed event); this
 * only extracts display fields and cross-checks the application id. Venues
 * verify the signature — this function never makes a trust decision.
 */
export function readInvitationClaims(token: string): InvitationClaimsView | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'USRP-SLOT' || parts[1] !== 'v1') return null;
  try {
    const c = JSON.parse(Buffer.from(parts[2] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof c['ticketId'] !== 'string' ||
      typeof c['applicationId'] !== 'string' ||
      typeof c['venueName'] !== 'string' ||
      typeof c['examDate'] !== 'string' ||
      typeof c['reportingTimeHour'] !== 'number' ||
      typeof c['expiresAt'] !== 'string'
    ) {
      return null;
    }
    return {
      ticketId: c['ticketId'],
      applicationId: c['applicationId'],
      venueName: c['venueName'],
      examDate: c['examDate'],
      reportingTimeHour: c['reportingTimeHour'],
      expiresAt: c['expiresAt'],
    };
  } catch {
    return null;
  }
}

export type InvitationDecision =
  | { readonly state: 'READY'; readonly claims: InvitationClaimsView; readonly token: string }
  | { readonly state: Exclude<InvitationState, 'READY'> };

/** Decide what the citizen may see for one application. */
export function decideInvitation(
  applicationId: string,
  status: ApplicationStatus,
  token: string | null,
  now: Date,
  admitted = false,
): InvitationDecision {
  if (status === 'ADJUDICATION_REVIEW') return { state: 'ON_HOLD' };
  if (COMPLETED_STATUSES.has(status)) return { state: 'COMPLETED' };
  if (PENDING_STATUSES.has(status)) return { state: 'PENDING' };
  if (WALK_IN_STATUSES.has(status)) return { state: 'WALK_IN' };
  if (!READY_STATUSES.has(status)) return { state: 'CLOSED' };
  if (admitted) return { state: 'ADMITTED' };
  if (token === null) return { state: 'UNAVAILABLE' };
  const claims = readInvitationClaims(token);
  // A token that names another application is never handed out.
  if (claims === null || claims.applicationId !== applicationId) return { state: 'UNAVAILABLE' };
  const expires = Date.parse(claims.expiresAt);
  if (Number.isNaN(expires) || now.getTime() >= expires) return { state: 'EXPIRED' };
  return { state: 'READY', claims, token };
}
