// ══════════════════════════════════════════════════════════════════
// application-service — SelfWithdrawalRepository port
//
// The voluntary withdrawal writer (ADR-020): a citizen, authenticated by
// their applicant session at the portal edge (identity-service), retires
// their OWN in-flight application. WITHDRAWN's second writer — the first
// was the ADR-017 auto-withdrawal sweep.
//
// Like ADR-017 this is a usrp_system_service write: the caller is the
// portal backend holding a system token, the target row may live in any
// of the three ops schemas, and no officer role could reach a citizen's
// rows across agencies. UNLIKE ADR-017, ownership is part of the
// contract: the row must match applicationId AND applicantId inside the
// same transaction — a citizen can never move anyone else's application.
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationStatus } from '@usrp/shared-types';

export interface WithdrawOwnInput {
  /** The authenticated citizen — established by the portal session, not the body. */
  readonly applicantId: string;
  readonly applicationId: string;
  readonly correlationId: string;
}

/**
 * WITHDRAWN        — a genuine transition happened (history appended).
 * NO_CHANGE        — already WITHDRAWN; idempotent success, nothing written.
 * NOT_APPLICABLE   — a terminal status a citizen cannot undo (ACCEPTED /
 *                    REJECTED / WALK_IN_REJECTED); nothing written.
 * NOT_FOUND        — no application with this id belongs to this applicant.
 *                    Deliberately covers both "no such id" and "not yours":
 *                    the door must not be an ownership oracle.
 */
export type WithdrawOwnOutcome =
  | { readonly kind: 'WITHDRAWN'; readonly agency: Agency; readonly fromStatus: ApplicationStatus }
  | { readonly kind: 'NO_CHANGE'; readonly agency: Agency }
  | { readonly kind: 'NOT_APPLICABLE'; readonly agency: Agency; readonly status: ApplicationStatus }
  | { readonly kind: 'NOT_FOUND' };

export interface SelfWithdrawalRepository {
  /**
   * In ONE transaction as usrp_system_service: locate the application by
   * (id, applicant_id) across the three ops schemas, lock it, and — if its
   * status is non-terminal — move it to WITHDRAWN, appending one
   * status-history row (performed_by 'APPLICANT': a citizen act, not the
   * system's and not an officer's).
   */
  withdrawOwn(input: WithdrawOwnInput): Promise<WithdrawOwnOutcome>;
}
