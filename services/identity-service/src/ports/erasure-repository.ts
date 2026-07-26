// ══════════════════════════════════════════════════════════════════
// identity-service — Erasure repository port (ADR-015)
//
// Right-to-erasure (Law N° 058/2021, tombstone-overwrite model). The
// adapter must perform gate + overwrite in ONE transaction and report a
// truthful outcome; the caller (service layer) audits every attempt.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

/**
 * Outcome of an erasure attempt.
 *
 * • ERASED — PII overwritten, hash rotated, deleted_at stamped, session
 *   rows deleted. Irreversible (rls/0014 freezes the row).
 * • ALREADY_ERASED — deleted_at was set before this call; idempotent
 *   success, nothing mutated.
 * • REFUSED_ACTIVE_APPLICATION — the citizen has at least one
 *   application not in a terminal status (REJECTED / WITHDRAWN); the
 *   first offender's agency + status are reported. Recruitment
 *   processing in progress is a lawful ground to defer erasure.
 * • REFUSED_ACCEPT_LOCKED — the citizen is accepted (enlisted) at
 *   lockedByAgency (ADR-014); the service-record retention obligation
 *   overrides erasure.
 * • NOT_FOUND — no identity row.
 */
export type EraseIdentityOutcome =
  | { readonly kind: 'ERASED' }
  | { readonly kind: 'ALREADY_ERASED' }
  | {
      readonly kind: 'REFUSED_ACTIVE_APPLICATION';
      readonly agency: Agency;
      readonly status: string;
    }
  | { readonly kind: 'REFUSED_ACCEPT_LOCKED'; readonly lockedByAgency: Agency }
  | { readonly kind: 'NOT_FOUND' };

export interface ErasureRepository {
  eraseIdentity(applicantId: string): Promise<EraseIdentityOutcome>;
}
