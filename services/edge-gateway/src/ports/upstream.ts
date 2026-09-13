// ══════════════════════════════════════════════════════════════════
// edge-gateway — Upstream ports
//
// Three gateways, one per service the edge fronts. Every method returns a
// NARROWED, EXPLICITLY REBUILT value — never the parsed upstream body.
//
// That is a security control, not a style preference. Upstream responses
// legitimately carry fields a browser must never receive:
//
//   • `lockedByAgency` on a 409 from POST /v1/applications/accept — naming
//     the agency that holds the ADR-014 lock discloses a sibling agency's
//     processing state to an officer who cannot see it. It is dropped HERE,
//     at the boundary, so no later code CAN leak it.
//   • `applicantId` from POST /v1/identities/verify — the officer console
//     identifies applicants by processing code; an opaque applicant key is
//     still a "who". It stays inside the edge (the walk-in flow needs it) and
//     never reaches a response.
//   • `qrInvitationCode` from a walk-in registration — a bearer credential
//     the field officer scans at the venue.
//
// A pass-through of `await res.json()` would ship all three the day upstream
// adds a field. An allowlist projection cannot.
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationChannel } from '@usrp/shared-types';

/** Correlation context threaded to upstream so one click is one trace. */
export interface UpstreamContext {
  readonly correlationId: string;
}

// ── Rows ───────────────────────────────────────────────────────────

/**
 * A list row. `processingCode` is the anonymous stand-in for the applicant —
 * the officer console is unusable without it and it names nobody.
 *
 * `status` is a STRING, never an enum: the `WALK_IN_*` values exist only in
 * `rdf_ops.application_status`, so narrowing here would type-check against RDF
 * fixtures and be wrong for two agencies out of three. The frontend narrows
 * per agency with `StatusFor<A>`.
 */
export interface ApplicationListRow {
  readonly applicationId: string;
  readonly processingCode: string;
  readonly category: string;
  readonly status: string;
  readonly submittedAt: string | null;
}

/** A citizen's own row — the agency joins it, because a citizen is cross-agency. */
export interface MyApplicationRow extends ApplicationListRow {
  readonly agency: string;
}

/** An officer review-queue row (ADR-011). Forensic signals are OFFICER-ONLY. */
export interface AmberQueueRow {
  readonly applicationId: string;
  readonly processingCode: string;
  readonly status: string;
  readonly documentType: string | null;
  readonly forensicsScore: number | null;
  readonly forensicsFlags: unknown;
  readonly queuedAt: string | null;
}

/** One entry of the append-only status trail — the Procedural Justice record. */
export interface StatusHistoryRow {
  readonly status: string;
  readonly fromStatus: string | null;
  readonly occurredAt: string;
  readonly actorKind: 'SYSTEM' | 'OFFICER';
  readonly note: string | null;
}

// ── Outcomes ────────────────────────────────────────────────────────

export type CredentialOutcome =
  | { readonly kind: 'OK'; readonly token: string; readonly expiresAt: Date }
  /** ONE shape for unknown handle, wrong password, disabled account, wrong or
   *  expired OTP. A code here would restore account enumeration. */
  | { readonly kind: 'REJECTED' };

export type IdentityVerifyOutcome =
  | { readonly kind: 'VERIFIED'; readonly applicantId: string }
  | { readonly kind: 'UNVERIFIED' };

/**
 * The result of any of the four officer transitions, the two walk-in writes
 * and the citizen withdrawal. Deliberately ONE union: the operations differ in
 * authority and request shape, not in the vocabulary of ways they can land.
 */
export type TransitionOutcome =
  | { readonly kind: 'APPLIED'; readonly toStatus: string }
  | { readonly kind: 'NO_CHANGE'; readonly currentStatus: string }
  | { readonly kind: 'NOT_APPLICABLE'; readonly currentStatus: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'INVALID_INPUT'; readonly reason: string }
  /** ADR-014 accept lock. The holding agency is NOT carried — see file header. */
  | { readonly kind: 'ACCEPT_LOCKED' }
  /** Walk-in against a non-RDF agency: only rdf_ops models WALK_IN_* statuses. */
  | { readonly kind: 'UNSUPPORTED_AGENCY' }
  /** The autonomous age verdict has not landed yet; the caller retries. */
  | { readonly kind: 'AGE_PENDING'; readonly currentStatus: string };

export type ErasureRequestOutcome =
  | {
      readonly kind: 'FOUND';
      readonly status: string;
      readonly filedAt: string;
      readonly decidedAt: string | null;
      readonly decisionNote: string | null;
    }
  | { readonly kind: 'NONE' };

// ── Gateways ────────────────────────────────────────────────────────

export interface IamGateway {
  officerLogin(
    loginHandle: string,
    password: string,
    ctx: UpstreamContext,
  ): Promise<CredentialOutcome>;
}

export interface IdentityGateway {
  /** ACCEPTED means "the request was accepted" and NOTHING about the subject. */
  requestOtp(
    nationalId: string,
    channel: ApplicationChannel,
    ctx: UpstreamContext,
  ): Promise<'ACCEPTED' | 'MALFORMED'>;
  verifyOtp(
    nationalId: string,
    otp: string,
    channel: ApplicationChannel,
    ctx: UpstreamContext,
  ): Promise<CredentialOutcome>;
  /** Revoke the opaque token upstream. ADR-018 chose revocability for this. */
  revokeApplicantSession(sessionToken: string, ctx: UpstreamContext): Promise<void>;
  /** BROKERED service-internal route (ADR-012 D1) — officer credential only. */
  verifyIdentity(
    officerToken: string,
    nationalId: string,
    channel: ApplicationChannel,
    ctx: UpstreamContext,
  ): Promise<IdentityVerifyOutcome>;
  listMyApplications(
    sessionToken: string,
    ctx: UpstreamContext,
  ): Promise<readonly MyApplicationRow[]>;
  withdrawMyApplication(
    sessionToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome>;
  getMyErasureRequest(
    sessionToken: string,
    ctx: UpstreamContext,
  ): Promise<ErasureRequestOutcome>;
  fileMyErasureRequest(sessionToken: string, ctx: UpstreamContext): Promise<void>;
}

/** The RDF board vs RNP/RCS certificate medical modes (ADR-013). */
export type MedicalVerdict =
  | { readonly mode: 'BOARD'; readonly fitnessStatus: 'FIT' | 'UNFIT' }
  | {
      readonly mode: 'CERTIFICATE';
      readonly certVerdict: 'CERT_VERIFIED' | 'CERT_REJECTED';
      readonly physicianName?: string;
    };

export interface WalkInRegistration {
  readonly applicantId: string;
  readonly category: string;
  readonly nesaIndexNumber?: string;
  readonly hecRegistrationNumber?: string;
}

export type WalkInRegisterOutcome =
  | { readonly kind: 'REGISTERED'; readonly applicationId: string; readonly status: string }
  | { readonly kind: 'FORBIDDEN' }
  | { readonly kind: 'UNSUPPORTED_AGENCY' }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'INVALID_INPUT'; readonly reason: string }
  | { readonly kind: 'CONFLICT'; readonly reason: string };

export interface ApplicationGateway {
  listApplications(
    officerToken: string,
    ctx: UpstreamContext,
  ): Promise<readonly ApplicationListRow[]>;
  listAmberQueue(officerToken: string, ctx: UpstreamContext): Promise<readonly AmberQueueRow[]>;
  /** null is BOTH "no such id" and "another agency's id" — indistinguishable. */
  findById(
    officerToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<Readonly<Record<string, unknown>> | null>;
  statusHistory(
    officerToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<readonly StatusHistoryRow[] | null>;
  medicalReview(
    officerToken: string,
    applicationId: string,
    verdict: MedicalVerdict,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome>;
  finalDecision(
    officerToken: string,
    applicationId: string,
    decision: 'SHORTLIST' | 'REJECT',
    notes: string | null,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome>;
  accept(
    officerToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome>;
  adjudicate(
    officerToken: string,
    applicationId: string,
    decision: 'CLEAR' | 'REJECT',
    notes: string | null,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome>;
  registerWalkIn(
    officerToken: string,
    registration: WalkInRegistration,
    ctx: UpstreamContext,
  ): Promise<WalkInRegisterOutcome>;
  vetWalkIn(
    officerToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome>;
}

/** Re-exported for adapters that need the channel vocabulary. */
export type { Agency, ApplicationChannel };
