// ══════════════════════════════════════════════════════════════════
// identity-service — ApplicationsGateway port (ADR-018 "my applications")
//
// The applicant portal's read of the citizen's own applications. The data
// lives in application-service (the single writer/owner of application
// state, ADR-006), so identity-service asks it over HTTP — authenticated
// with identity-service's OWN client-credentials system token (ADR-016).
// The application core depends on this interface, never on fetch/tokens.
// ══════════════════════════════════════════════════════════════════

import type { ApplicationCategory } from '@usrp/shared-types';

/** Mirrors application-service's ApplicantApplicationSummary — non-PII. */
export interface ApplicantApplication {
  readonly applicationId: string;
  readonly agency: string;
  readonly processingCode: string;
  readonly category: string;
  readonly status: string;
  readonly submittedAt: string | null;
}

/**
 * Upstream outcome of a voluntary withdrawal (ADR-020) — a passthrough of
 * application-service's withdraw-own contract, PII-free by construction.
 */
export type WithdrawApplicationResult =
  | { readonly kind: 'WITHDRAWN'; readonly agency: string; readonly fromStatus: string }
  | { readonly kind: 'NO_CHANGE'; readonly agency: string }
  | { readonly kind: 'NOT_APPLICABLE'; readonly agency: string; readonly currentStatus: string }
  | { readonly kind: 'NOT_FOUND' };

/**
 * The citizen's own submission (ADR-027 browser front door): category plus
 * the academic credential the category requires. The applicantId and the
 * `channel: 'WEB'` are NOT inputs — the route derives the subject from the
 * authenticated session and the browser channel is a server-side fact, so
 * neither can be forged from a request body.
 */
export interface ApplicantSubmitInput {
  readonly category: ApplicationCategory;
  readonly nesaIndexNumber?: string | null;
  readonly hecRegistrationNumber?: string | null;
}

/**
 * Typed outcome of a submission, one kind per answer the citizen can get.
 *
 * The four integrity answers (SUBMITTED / REPLAYED / KEY_REUSED /
 * ALREADY_APPLIED) mirror application-service's ledger contract exactly
 * (ADR-027): a replay keeps the first submission's identifiers, a key
 * reuse carries NO identifiers, and a live duplicate names the application
 * already on file. Business preconditions (identity, academic input,
 * campaign) arrive as their own kinds so the HTTP mapping stays explicit.
 *
 * DEPENDENCY_UNAVAILABLE and UNEXPECTED_UPSTREAM_RESPONSE fail SAFE: the
 * first is any transport/5xx/401-token fault (nothing was written), the
 * second is a response that does not match the pinned contract — the raw
 * body is never surfaced, never logged, never echoed.
 */
export type ApplicantSubmitResult =
  | { readonly kind: 'SUBMITTED'; readonly applicationId: string; readonly processingCode: string; readonly agency: string }
  | { readonly kind: 'REPLAYED'; readonly applicationId: string; readonly processingCode: string; readonly agency: string }
  | { readonly kind: 'ALREADY_APPLIED'; readonly applicationId: string; readonly processingCode: string; readonly agency: string }
  | { readonly kind: 'KEY_REUSED'; readonly reason: string }
  | { readonly kind: 'APPLICANT_NOT_FOUND' }
  | { readonly kind: 'IDENTITY_NOT_VERIFIED' }
  | { readonly kind: 'INVALID_ACADEMIC_INPUT'; readonly reason: string }
  | { readonly kind: 'NO_OPEN_CAMPAIGN'; readonly agency: string }
  | { readonly kind: 'DEPENDENCY_UNAVAILABLE' }
  | { readonly kind: 'UNEXPECTED_UPSTREAM_RESPONSE' };

export interface ApplicationsGateway {
  /** All of one applicant's applications, cross-agency. */
  listForApplicant(applicantId: string): Promise<readonly ApplicantApplication[]>;
  /** Withdraw the citizen's OWN application (ADR-020) — ownership enforced upstream. */
  withdrawApplication(applicantId: string, applicationId: string): Promise<WithdrawApplicationResult>;
  /**
   * Submit a NEW application for the citizen (ADR-027). The subject travels
   * server-derived; `idempotencyKey` is the caller's validated UUID retry
   * identity, forwarded EXACTLY; ownership and every business rule are
   * enforced upstream inside the ledger transaction.
   */
  submitForApplicant(
    applicantId: string,
    input: ApplicantSubmitInput,
    idempotencyKey: string,
  ): Promise<ApplicantSubmitResult>;
}
