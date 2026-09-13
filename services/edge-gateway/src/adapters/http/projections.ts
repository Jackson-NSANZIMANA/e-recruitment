// ══════════════════════════════════════════════════════════════════
// edge-gateway — Response projections (ALLOWLISTS, not pass-throughs)
//
// Every function here takes `unknown` — an upstream body the edge does not
// control — and returns a shape it fully enumerates. That direction is the
// whole design: when application-service adds a column to a read, the browser
// sees nothing new until someone edits this file, which is a reviewable diff.
//
// A proxy that forwards the upstream body is a proxy whose contract is "whatever
// upstream happens to return today". Three specific leaks this prevents:
//
//   • documentLane / documentForensicsScore / documentForensicsFlags exist on
//     ApplicationDetail. They are legitimate on the OFFICER review surface and
//     are a forgery-tuning oracle on any applicant-reachable one. The citizen
//     list projection has no field for them.
//   • CROSS_AGENCY_LOCKED carries `lockedByAgency` upstream. The edge contract
//     forbids naming the holding agency — that discloses a sibling agency's
//     processing state to an officer who cannot see it. Stripped here.
//   • StatusHistoryEntry carries `actor`, an officer UUID, and `correlationId`.
//     Neither belongs in a browser payload; `actorKind` answers the question
//     the UI actually asks (human or automated step).
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';
import { isRecord } from './validation.js';

// ── Primitive readers. Absent / wrong-typed becomes null, never undefined
//    leaking into JSON as a missing key with a different meaning. ──

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function rows(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Pull `field` off an upstream body that may or may not be an object. */
export function field(body: unknown, name: string): unknown {
  return isRecord(body) ? body[name] : undefined;
}

// ── List rows ─────────────────────────────────────────────────────

export interface EdgeApplicationListItem {
  readonly applicationId: string | null;
  readonly processingCode: string | null;
  readonly category: string | null;
  /** Compared as TEXT upstream, never cast to an enum: WALK_IN_* exists only in
   *  rdf_ops (ADR-017 / ADR-020), so a cast passes every RDF fixture and fails
   *  in production for two agencies out of three. */
  readonly status: string | null;
  readonly agency: Agency;
  readonly submittedAt: string | null;
}

/**
 * Officer list rows. `agency` is INJECTED from the verified session, not read
 * from the row — the upstream envelope carries it once and the browser wants it
 * per row. Taking it from the session is what keeps it server-authoritative.
 */
export function projectListItems(body: unknown, agency: Agency): readonly EdgeApplicationListItem[] {
  return rows(field(body, 'applications')).map((row) => ({
    applicationId: str(field(row, 'applicationId')),
    processingCode: str(field(row, 'processingCode')),
    category: str(field(row, 'category')),
    status: str(field(row, 'status')),
    agency,
    submittedAt: str(field(row, 'submittedAt')),
  }));
}

/**
 * Citizen list rows. Here `agency` DOES come from the row — a citizen is
 * cross-agency by construction (ADR-014, ADR-018) and the session carries no
 * agency to inject. Rows whose agency is unreadable are dropped rather than
 * defaulted: a mislabelled agency on a citizen's own record is worse than an
 * absent row.
 */
export function projectMyApplications(body: unknown): readonly EdgeApplicationListItem[] {
  const out: EdgeApplicationListItem[] = [];
  for (const row of rows(field(body, 'applications'))) {
    const agency = str(field(row, 'agency'));
    if (agency !== 'RDF' && agency !== 'RNP' && agency !== 'RCS') continue;
    out.push({
      applicationId: str(field(row, 'applicationId')),
      processingCode: str(field(row, 'processingCode')),
      category: str(field(row, 'category')),
      status: str(field(row, 'status')),
      agency,
      submittedAt: str(field(row, 'submittedAt')),
    });
  }
  return out;
}

// ── The officer detail record ──────────────────────────────────────

export interface EdgeApplication {
  readonly applicationId: string | null;
  readonly processingCode: string | null;
  readonly category: string | null;
  readonly status: string | null;
  readonly agency: Agency;

  readonly academicStatus: string | null;
  readonly nesaIndexNumber: string | null;
  readonly nesaVerifiedAt: string | null;
  readonly hecRegistrationNumber: string | null;
  readonly hecVerifiedAt: string | null;
  readonly declaredSpecialistField: string | null;
  readonly academicEligibilityDetail: Record<string, unknown> | null;

  readonly ageEligibilityStatus: string | null;
  readonly ageVerifiedAt: string | null;
  /** `{ eligible, ageAtEvaluation, appliedMaxAge, reason }` — never a date of birth. */
  readonly ageEligibilityDetail: Record<string, unknown> | null;

  readonly criminalClearanceStatus: string | null;
  readonly criminalClearanceAt: string | null;

  // Forensic signals are OFFICER-ONLY and appear on no citizen projection.
  readonly documentLane: string | null;
  readonly documentForensicsScore: number | null;
  readonly documentForensicsFlags: Record<string, unknown> | null;
  readonly documentReviewedAt: string | null;
  readonly documentReviewDecision: string | null;

  readonly assignedDistrict: string | null;
  readonly assignedVenueName: string | null;
  readonly physicalTestScheduledAt: string | null;
  readonly physicalTestCompletedAt: string | null;
  readonly qrInvitationIssuedAt: string | null;
  readonly smsNotificationSentAt: string | null;

  readonly finalDecisionAt: string | null;
  readonly finalDecisionNotes: string | null;

  readonly submittedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * The full officer detail view.
 *
 * FOUR UPSTREAM FIELDS ARE DELIBERATELY ABSENT even though the upstream read
 * returns them: `documentReviewedById` and `finalDecisionById` are internal
 * officer UUIDs, and the upstream port already omits `applicantId` and
 * `qrInvitationCode` for the same reason (the latter is a bearer ticket a field
 * officer scans). Enumerating the keep-list rather than a strip-list means a
 * newly added upstream column is invisible here until someone adds it on
 * purpose.
 */
export function projectApplication(body: unknown, agency: Agency): EdgeApplication | null {
  const app = field(body, 'application');
  if (!isRecord(app)) return null;
  return {
    applicationId: str(app.applicationId),
    processingCode: str(app.processingCode),
    category: str(app.category),
    status: str(app.status),
    agency,

    academicStatus: str(app.academicStatus),
    nesaIndexNumber: str(app.nesaIndexNumber),
    nesaVerifiedAt: str(app.nesaVerifiedAt),
    hecRegistrationNumber: str(app.hecRegistrationNumber),
    hecVerifiedAt: str(app.hecVerifiedAt),
    declaredSpecialistField: str(app.declaredSpecialistField),
    academicEligibilityDetail: jsonObject(app.academicEligibilityDetail),

    ageEligibilityStatus: str(app.ageEligibilityStatus),
    ageVerifiedAt: str(app.ageVerifiedAt),
    ageEligibilityDetail: jsonObject(app.ageEligibilityDetail),

    criminalClearanceStatus: str(app.criminalClearanceStatus),
    criminalClearanceAt: str(app.criminalClearanceAt),

    documentLane: str(app.documentLane),
    documentForensicsScore: num(app.documentForensicsScore),
    documentForensicsFlags: jsonObject(app.documentForensicsFlags),
    documentReviewedAt: str(app.documentReviewedAt),
    documentReviewDecision: str(app.documentReviewDecision),

    assignedDistrict: str(app.assignedDistrict),
    assignedVenueName: str(app.assignedVenueName),
    physicalTestScheduledAt: str(app.physicalTestScheduledAt),
    physicalTestCompletedAt: str(app.physicalTestCompletedAt),
    qrInvitationIssuedAt: str(app.qrInvitationIssuedAt),
    smsNotificationSentAt: str(app.smsNotificationSentAt),

    finalDecisionAt: str(app.finalDecisionAt),
    finalDecisionNotes: str(app.finalDecisionNotes),

    submittedAt: str(app.submittedAt),
    createdAt: str(app.createdAt),
    updatedAt: str(app.updatedAt),
  };
}

// ── Status history ──────────────────────────────────────────────

export interface EdgeStatusHistoryEntry {
  readonly entryId: string | null;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  /** Alias of `toStatus`, so a timeline component can read one field name. */
  readonly status: string | null;
  readonly note: string | null;
  /** SYSTEM or OFFICER. NOT the actor id — see the file header. */
  readonly actorKind: string | null;
  readonly occurredAt: string | null;
}

export function projectStatusHistory(body: unknown): readonly EdgeStatusHistoryEntry[] {
  return rows(field(body, 'history')).map((entry) => {
    const toStatus = str(field(entry, 'toStatus'));
    return {
      entryId: str(field(entry, 'entryId')),
      fromStatus: str(field(entry, 'fromStatus')),
      toStatus,
      status: toStatus,
      note: str(field(entry, 'note')),
      actorKind: str(field(entry, 'actorKind')),
      occurredAt: str(field(entry, 'at')),
    };
  });
}

// ── Amber review queue (officer-only by construction) ─────────────────

export interface EdgeAmberQueueEntry {
  readonly applicationId: string | null;
  readonly processingCode: string | null;
  readonly status: string | null;
  readonly documentType: string | null;
  readonly forensicsScore: number | null;
  readonly forensicsFlags: Record<string, unknown> | null;
  readonly queuedAt: string | null;
  readonly agency: Agency;
}

export function projectAmberQueue(body: unknown, agency: Agency): readonly EdgeAmberQueueEntry[] {
  return rows(field(body, 'queue')).map((entry) => ({
    applicationId: str(field(entry, 'applicationId')),
    processingCode: str(field(entry, 'processingCode')),
    status: str(field(entry, 'status')),
    documentType: str(field(entry, 'documentType')),
    forensicsScore: num(field(entry, 'forensicsScore')),
    forensicsFlags: jsonObject(field(entry, 'forensicsFlags')),
    queuedAt: str(field(entry, 'queuedAt')),
    agency,
  }));
}

// ── Transitions ────────────────────────────────────────────────

export interface EdgeTransitionResult {
  readonly applicationId: string;
  /** APPLIED or NO_CHANGE. NOT an Application — callers re-read after a write. */
  readonly outcome: string;
  readonly fromStatus: string | null;
  readonly status: string | null;
}

/**
 * The 200 body of any transition.
 *
 * `applicationId` is echoed from the REQUEST, not the response: the upstream
 * transition bodies do not carry it, and the client needs it to reconcile which
 * row to re-read.
 */
export function projectTransition(applicationId: string, body: unknown): EdgeTransitionResult {
  const outcome = str(field(body, 'status')) ?? 'APPLIED';
  if (outcome === 'NO_CHANGE') {
    return {
      applicationId,
      outcome: 'NO_CHANGE',
      fromStatus: null,
      status: str(field(body, 'currentStatus')),
    };
  }
  return {
    applicationId,
    outcome: 'APPLIED',
    fromStatus: str(field(body, 'fromStatus')),
    status: str(field(body, 'toStatus')),
  };
}
