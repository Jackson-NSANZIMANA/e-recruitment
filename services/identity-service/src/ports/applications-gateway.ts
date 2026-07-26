// ══════════════════════════════════════════════════════════════════
// identity-service — ApplicationsGateway port (ADR-018 "my applications")
//
// The applicant portal's read of the citizen's own applications. The data
// lives in application-service (the single writer/owner of application
// state, ADR-006), so identity-service asks it over HTTP — authenticated
// with identity-service's OWN client-credentials system token (ADR-016).
// The application core depends on this interface, never on fetch/tokens.
// ══════════════════════════════════════════════════════════════════

/** Mirrors application-service's ApplicantApplicationSummary — non-PII. */
export interface ApplicantApplication {
  readonly applicationId: string;
  readonly agency: string;
  readonly processingCode: string;
  readonly category: string;
  readonly status: string;
  readonly submittedAt: string | null;
}

export interface ApplicationsGateway {
  /** All of one applicant's applications, cross-agency. */
  listForApplicant(applicantId: string): Promise<readonly ApplicantApplication[]>;
}
