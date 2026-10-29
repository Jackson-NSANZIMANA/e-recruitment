// ══════════════════════════════════════════════════════════════════
// application-service — attach a criminal-clearance certificate number
// (ADR-048 §2.3). The citizen requested a criminal-record certificate on
// IremboGov and gives us its application number. Here we only establish that
// the application is theirs and still open, and stage
// CLEARANCE_CERTIFICATE_SUBMITTED for background-vetting-service, which does
// the verification (authentic, allowed type, validity window, identity
// binding). The number is NOT stored here and never logged: it travels in the
// event so the check can be retried after a registry outage.
//
//   ACCEPTED          the check is under way (202); the result reaches the
//                     checklist and, when a human must look, the amber queue.
//   ALREADY_VERIFIED  the criminal gate is already CLEARED; nothing to do.
//   NOT_APPLICABLE    the application is closed (rejected, withdrawn, accepted).
//   NOT_FOUND         no such application for this applicant (never an oracle).
//   INVALID_NUMBER    not in the observed shape; the applicant may correct it.
// ══════════════════════════════════════════════════════════════════

import type { Principal } from '@usrp/shared-auth';
import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import type { Agency, ApplicationStatus, ClearanceCertificateSubmittedEvent } from '@usrp/shared-types';
import { parseClearanceNumber } from '../domain/clearance-number.js';
import { kigaliDate } from '../domain/gate-admission.js';
import type { ClearanceAttachRepository } from '../ports/clearance-attach-repository.js';

/** Statuses a citizen can no longer change anything on (compared as text; see the ADR-017 idiom). */
const CLOSED: ReadonlySet<string> = new Set(['REJECTED', 'WITHDRAWN', 'ACCEPTED', 'WALK_IN_REJECTED']);

export interface AttachClearanceCommand {
  readonly actor: Principal;
  readonly applicantId: string;
  readonly applicationId: string;
  /** As typed by the citizen; normalised and shape-checked here. */
  readonly clearanceCertificateNumber: string;
  readonly context: EventContext;
}

export type AttachClearanceOutcome =
  | { readonly kind: 'ACCEPTED'; readonly agency: Agency }
  | { readonly kind: 'ALREADY_VERIFIED'; readonly agency: Agency }
  | { readonly kind: 'NOT_APPLICABLE'; readonly agency: Agency; readonly status: ApplicationStatus }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'INVALID_NUMBER' }
  | { readonly kind: 'NOT_ENABLED' }
  | { readonly kind: 'FORBIDDEN' };

export interface AttachClearanceDeps {
  readonly repository: ClearanceAttachRepository;
  readonly eventBus: EventBus;
  readonly clock?: () => Date;
  /**
   * The Irembo certificate flow is on (CLEARANCE_MODE=IREMBO_CERTIFICATE). When it is
   * off nothing consumes clearance.submitted, so accepting a number would be a lie.
   */
  readonly enabled?: boolean;
}

export class AttachClearanceCertificateService {
  constructor(private readonly deps: AttachClearanceDeps) {}

  async attach(command: AttachClearanceCommand): Promise<AttachClearanceOutcome> {
    if (command.actor.kind !== 'system') return { kind: 'FORBIDDEN' };
    if (this.deps.enabled === false) return { kind: 'NOT_ENABLED' };
    const number = parseClearanceNumber(command.clearanceCertificateNumber);
    if (number === null) return { kind: 'INVALID_NUMBER' };

    const own = await this.deps.repository.findOwn(command.applicantId, command.applicationId);
    if (own === null) return { kind: 'NOT_FOUND' };
    if (CLOSED.has(own.status)) return { kind: 'NOT_APPLICABLE', agency: own.agency, status: own.status };
    if (own.criminalStatus === 'CLEARED') return { kind: 'ALREADY_VERIFIED', agency: own.agency };

    const clearancePolicy = own.clearancePolicy;
    const event: ClearanceCertificateSubmittedEvent = {
      ...newEnvelope(command.context),
      eventType: 'CLEARANCE_CERTIFICATE_SUBMITTED',
      applicantId: command.applicantId,
      applicationId: command.applicationId,
      agency: own.agency,
      category: own.category,
      clearanceCertificateNumber: number,
      referenceDate: kigaliDate((this.deps.clock ?? ((): Date => new Date()))()),
      ...(clearancePolicy === null ? {} : { clearancePolicy }),
    };
    await this.deps.eventBus.publish(event);
    return { kind: 'ACCEPTED', agency: own.agency };
  }
}
