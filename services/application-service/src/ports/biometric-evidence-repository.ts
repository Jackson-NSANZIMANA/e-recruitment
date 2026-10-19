// ══════════════════════════════════════════════════════════════════
// application-service — BiometricEvidenceRepository port (ADR-037)
//
// Both methods run AS THE OFFICER'S OWN AGENCY ROLE, so rls/0034 makes SHADOW
// evidence invisible to them: the officer read cannot list it and a
// supervisor cannot confirm it. A sibling agency's rows are not merely
// filtered: the role has no grant on that schema.
// ══════════════════════════════════════════════════════════════════

import type { EvidenceOutcome, ManualIdentityReason } from '../domain/gate-identity.js';
import type { StageEvents } from './event-outbox.js';
import type { OfficerActor } from './officer-transition-repository.js';

/** What an officer may see of one evidence record. No device internals. */
export interface EvidenceView {
  readonly recordId: string;
  readonly ticketId: string;
  readonly referenceSource: string;
  readonly method: string;
  readonly consentState: string;
  readonly outcome: EvidenceOutcome;
  readonly notAttemptedReason: string | null;
  readonly livenessScoreBp: number | null;
  readonly matchScoreBp: number | null;
  readonly modelId: string | null;
  readonly modelVersion: string | null;
  readonly thresholdPolicyVersion: string;
  readonly mode: 'ADVISORY';
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly manualIdentity: { readonly reasonCode: ManualIdentityReason; readonly confirmedAt: string } | null;
}

export type EvidenceListOutcome =
  | { readonly kind: 'OK'; readonly applicationId: string; readonly evidence: readonly EvidenceView[] }
  | { readonly kind: 'NOT_FOUND' };

export type ConfirmManualIdentityOutcome =
  | { readonly kind: 'CONFIRMED'; readonly confirmationId: string; readonly recordId: string; readonly applicationId: string; readonly confirmedAt: string }
  /** Unknown, SHADOW, or another agency's record — one indistinguishable answer. */
  | { readonly kind: 'NOT_FOUND' }
  /** MATCH or NOT_ATTEMPTED evidence needs no confirmation. */
  | { readonly kind: 'NOT_REQUIRED' }
  | { readonly kind: 'ALREADY_CONFIRMED' }
  /** The supervisor captured this evidence themselves. */
  | { readonly kind: 'SAME_OFFICER' };

export interface BiometricEvidenceRepository {
  list(actor: OfficerActor, applicationId: string): Promise<EvidenceListOutcome>;
  confirm(
    actor: OfficerActor,
    recordId: string,
    reasonCode: ManualIdentityReason,
    stage: StageEvents<ConfirmManualIdentityOutcome>,
  ): Promise<ConfirmManualIdentityOutcome>;
}
