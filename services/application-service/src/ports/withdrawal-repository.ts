// ══════════════════════════════════════════════════════════════════
// application-service — WithdrawalRepository port
//
// The auto-withdrawal writer (ADR-017): when one agency ACCEPTS a citizen
// (the accept-lock won, ADR-014), every OTHER in-flight application of that
// citizen — any agency, any campaign, either lane, including ADJUDICATION_
// REVIEW holds (owner D6) — is retired to WITHDRAWN. Enlistment moots them.
//
// Unlike the officer transitions (which run as the officer's own agency
// role), this is deliberately a usrp_system_service write: the trigger is a
// platform-level fact, and the rows to retire live across ALL THREE ops
// schemas — no officer role can reach the siblings' schemas, and no officer
// made this decision. WITHDRAWN gets its first writer here.
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationStatus } from '@usrp/shared-types';

/** One application retired by the sweep — the audit trail's raw material. */
export interface WithdrawnApplication {
  readonly applicationId: string;
  readonly agency: Agency;
  readonly fromStatus: ApplicationStatus;
}

export interface WithdrawSiblingsInput {
  readonly applicantId: string;
  /** The winning application — never touched by the withdrawal. */
  readonly acceptedApplicationId: string;
  readonly correlationId: string;
}

export interface WithdrawalRepository {
  /**
   * In ONE transaction as usrp_system_service: move every non-terminal
   * application of the applicant (terminal = REJECTED / WITHDRAWN / ACCEPTED /
   * WALK_IN_REJECTED), across all three ops schemas, except the accepted one,
   * to WITHDRAWN — appending one status-history row each. Returns what was
   * withdrawn; an empty array means nothing was in flight (idempotent
   * redelivery lands here).
   */
  withdrawSiblings(input: WithdrawSiblingsInput): Promise<readonly WithdrawnApplication[]>;
}
