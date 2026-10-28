// ══════════════════════════════════════════════════════════════════
// application-service — Document checklist + venue verification (ADR-032)
//
// ADVISORY by owner decision (2026-10-14): nothing here moves an application.
// The checklist tells the citizen and the officer the state of every required
// item; venue verification lets the front-door check-in officer record that
// they saw a paper. Both are attributed, audited facts — never a status write.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import { AGENCY_DOCUMENT_TYPES, type Agency, type ApplicationStatus, type AuditEvent, type DocumentType } from '@usrp/shared-types';
import {
  evaluateDocumentChecklist,
  resolveRequiredDocuments,
  type DocumentChecklist,
} from '../domain/document-requirements.js';
import type { ChecklistFacts, DocumentChecklistRepository } from '../ports/document-checklist-repository.js';

/** A terminal application takes no further documents. */
const TERMINAL: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'REJECTED',
  'WITHDRAWN',
  'ACCEPTED',
  'WALK_IN_REJECTED',
]);

export type ChecklistOutcome =
  | { readonly kind: 'OK'; readonly agency: Agency; readonly checklist: DocumentChecklist }
  | { readonly kind: 'NOT_FOUND' };

export type VenueVerificationOutcome =
  | { readonly kind: 'RECORDED' | 'ALREADY_RECORDED'; readonly checklist: DocumentChecklist }
  | { readonly kind: 'NOT_FOUND' }
  /** The type is not on this application's required list — nothing to clear. */
  | { readonly kind: 'NOT_REQUIRED' }
  /** The agency cannot store this type at all (a legacy/foreign policy entry). */
  | { readonly kind: 'UNSUPPORTED_DOCUMENT_TYPE' }
  /** The application is terminal; no further documents are taken. */
  | { readonly kind: 'NOT_APPLICABLE'; readonly currentStatus: ApplicationStatus };

export interface DocumentChecklistDeps {
  readonly repository: DocumentChecklistRepository;
  readonly eventBus: EventBus;
  /** Show the clearance-certificate state (the Irembo flow is on). Default off. */
  readonly clearanceEnabled?: boolean;
}

function checklistOf(facts: ChecklistFacts, clearanceEnabled: boolean): DocumentChecklist {
  const checklist = evaluateDocumentChecklist(
    facts.category,
    resolveRequiredDocuments(facts.category, facts.policyRequired),
    facts.gates,
    facts.documents,
  );
  if (clearanceEnabled) return checklist;
  // Flow off: nobody would ever answer a number, so the state is not offered.
  return { ...checklist, items: checklist.items.map(({ clearance: _omitted, ...item }) => item) };
}

export class DocumentChecklistService {
  constructor(private readonly deps: DocumentChecklistDeps) {}

  /** The officer's view — their own agency only. */
  async forOfficer(actor: Principal, applicationId: string): Promise<ChecklistOutcome> {
    if (actor.kind !== 'officer') return { kind: 'NOT_FOUND' };
    const facts = await this.deps.repository.loadForOfficer(
      { agency: actor.agency, dbRole: dbRoleForPrincipal(actor) },
      applicationId,
    );
    return facts === null ? { kind: 'NOT_FOUND' } : { kind: 'OK', agency: facts.agency, checklist: checklistOf(facts, this.deps.clearanceEnabled === true) };
  }

  /** The citizen's view — only an application the session subject owns. */
  async forApplicant(applicantId: string, applicationId: string): Promise<ChecklistOutcome> {
    const facts = await this.deps.repository.loadForApplicant(applicantId, applicationId);
    return facts === null ? { kind: 'NOT_FOUND' } : { kind: 'OK', agency: facts.agency, checklist: checklistOf(facts, this.deps.clearanceEnabled === true) };
  }

  /**
   * The check-in officer saw the paper. The caller has already proven
   * `document.verify.venue`; this enforces that the type is REQUIRED for this
   * application and that the application is still live.
   */
  async verifyAtVenue(
    actor: Principal,
    applicationId: string,
    documentType: DocumentType,
    context: EventContext,
  ): Promise<VenueVerificationOutcome> {
    if (actor.kind !== 'officer') return { kind: 'NOT_FOUND' };
    const scope = { agency: actor.agency, dbRole: dbRoleForPrincipal(actor) };
    const facts = await this.deps.repository.loadForOfficer(scope, applicationId);
    if (facts === null) return { kind: 'NOT_FOUND' };
    if (TERMINAL.has(facts.status)) return { kind: 'NOT_APPLICABLE', currentStatus: facts.status };
    const required = resolveRequiredDocuments(facts.category, facts.policyRequired);
    if (!required.types.includes(documentType)) return { kind: 'NOT_REQUIRED' };
    if (!AGENCY_DOCUMENT_TYPES[facts.agency].has(documentType)) return { kind: 'UNSUPPORTED_DOCUMENT_TYPE' };

    const write = await this.deps.repository.recordVenueVerification({
      ...scope,
      officerId: actor.subjectId,
      applicationId,
      documentType,
    });
    if (write === 'RECORDED') {
      const audit: AuditEvent = {
        ...newEnvelope(context),
        eventType: 'AUDIT_ENTRY',
        entityType: 'APPLICATION',
        entityId: applicationId,
        action: 'DOCUMENT_VERIFIED_AT_VENUE',
        performedBy: actor.subjectId,
        agency: actor.agency,
        metadata: { documentType },
      };
      await this.deps.eventBus.publish(audit);
    }
    const after = await this.deps.repository.loadForOfficer(scope, applicationId);
    return { kind: write, checklist: checklistOf(after ?? facts, this.deps.clearanceEnabled === true) };
  }
}
