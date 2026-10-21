// ══════════════════════════════════════════════════════════════════
// application-service — GateAdmissionRepository port (BUILD-003, ADR-034)
//
// One method, one transaction, AS THE OFFICER'S OWN AGENCY ROLE: lock the
// application, decide (domain/gate-admission.ts), consult the agency-scoped
// identity-match function only for a genuine unspent ticket, write the
// admission + status advance + history, log the attempt, and stage the audit
// events — all or nothing. Every scan, refused or not, leaves an attempt row.
// ══════════════════════════════════════════════════════════════════

import type { ApplicationCategory, ApplicationStatus } from '@usrp/shared-types';
import type { GateTicketClaims } from '../domain/gate-admission.js';
import type { IdentityMethod } from '../domain/gate-identity.js';
import type { StageEvents } from './event-outbox.js';
import type { OfficerActor } from './officer-transition-repository.js';

export interface GateAdmissionInput {
  readonly actor: OfficerActor;
  /** The raw QR text as scanned. */
  readonly token: string;
  /** parseGateTicket(token), or null when the QR is not a ticket at all. */
  readonly claims: GateTicketClaims | null;
  /** The venue this gate is at, as configured on the officer's device. */
  readonly gateVenueName: string;
  /** HMAC of the national ID on the card, computed by identity-service. */
  readonly nationalIdHash: string;
  readonly now: Date;
}

/** The candidate, as the gate officer needs to direct them. PII-free. */
export interface GateCandidate {
  readonly applicationId: string;
  readonly processingCode: string;
  readonly category: ApplicationCategory;
}

export type GateAdmissionOutcome =
  | {
      readonly outcome: 'ADMITTED';
      readonly candidate: GateCandidate;
      readonly ticketId: string;
      readonly venueName: string;
      readonly examDate: string;
      readonly reportingTimeHour: number;
      readonly admittedAt: string;
      readonly fromStatus: ApplicationStatus;
      /** PHYSICAL_TEST_SCHEDULED when this admission advanced the row; null if it already was. */
      readonly advancedTo: 'PHYSICAL_TEST_SCHEDULED' | null;
      /** ADR-037: the identity method recorded, and the evidence it relied on. */
      readonly identityMethod: IdentityMethod;
      readonly evidenceIds: readonly string[];
      readonly confirmationIds: readonly string[];
    }
  | { readonly outcome: 'MANUAL_IDENTITY_REQUIRED'; readonly candidate: GateCandidate; readonly evidenceIds: readonly string[] }
  | {
      readonly outcome: 'ALREADY_ADMITTED';
      readonly candidate: GateCandidate;
      readonly admittedAt: string;
      readonly venueName: string;
      readonly admittedBySelf: boolean;
    }
  | { readonly outcome: 'NOT_ADMISSIBLE'; readonly candidate: GateCandidate; readonly currentStatus: ApplicationStatus }
  | { readonly outcome: 'IDENTITY_MISMATCH'; readonly candidate: GateCandidate }
  | { readonly outcome: 'WRONG_VENUE'; readonly ticketVenueName: string }
  | { readonly outcome: 'TOO_EARLY' | 'EXPIRED'; readonly examDate: string }
  | { readonly outcome: 'MALFORMED_TICKET' | 'WRONG_AGENCY' | 'UNKNOWN_TICKET' | 'TICKET_NOT_ISSUED' };

export interface GateAdmissionRepository {
  admit(input: GateAdmissionInput, stage: StageEvents<GateAdmissionOutcome>): Promise<GateAdmissionOutcome>;
}
