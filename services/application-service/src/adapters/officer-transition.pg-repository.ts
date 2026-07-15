// ══════════════════════════════════════════════════════════════════
// application-service — OfficerTransitionRepository adapter (PostgreSQL)
//
// The first production WRITE path to `SET LOCAL ROLE usrp_<agency>_officer`
// rather than usrp_system_service. Each transition runs in one transaction:
//
//   1. Assume the officer's DB role (from the verified token). The officer
//      role has no grant on sibling ops schemas, so a mis-routed write would
//      raise permission-denied — cross-agency isolation is DB-enforced, not
//      just guarded in code.
//   2. SELECT the row FOR UPDATE from the officer's own agency schema. Absent
//      → NOT_FOUND (the cross-agency guard: another agency's app is invisible).
//   3. A pure guard decides APPLY / NO_CHANGE / NOT_APPLICABLE (see `decide`).
//   4. On APPLY: UPDATE the status + stamp the reviewer/decider columns, then
//      append an application_status_history row (append-only per rls/0007).
//
// The audit entry is emitted by the use case, not here — this adapter owns
// only the durable state change. Each method is self-contained (mirrors the
// system_service apply* methods on PgApplicationRepository); the only shared
// piece is the pure `decide` guard, which touches no I/O.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type {
  AcademicEligibilityStatus,
  AgeEligibilityStatus,
  ApplicationCategory,
  ApplicationStatus,
  CriminalClearanceStatus,
} from '@usrp/shared-types';
import type {
  AcceptInput,
  AdjudicateInput,
  AdjudicateOutcome,
  FinalDecisionInput,
  MedicalReviewInput,
  OfficerTransitionOutcome,
  OfficerTransitionRepository,
} from '../ports/officer-transition-repository.js';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import { deriveApplicationStatus } from '../domain/lifecycle.js';

/** Statuses an officer may adjudicate (ADR-011). */
const ADJUDICABLE: ReadonlySet<ApplicationStatus> = new Set<ApplicationStatus>([
  'DOCUMENT_REVIEW_AMBER',
  'ADJUDICATION_REVIEW',
]);

export class PgOfficerTransitionRepository implements OfficerTransitionRepository {
  async medicalReview(input: MedicalReviewInput): Promise<OfficerTransitionOutcome> {
    const { actor, applicationId, fitnessStatus } = input;
    const requiredFrom: ApplicationStatus = 'PHYSICAL_TEST_COMPLETE';
    const target: ApplicationStatus = fitnessStatus === 'FIT' ? 'MEDICAL_REVIEW' : 'REJECTED';
    const schema = sql(schemaForAgency(actor.agency)); // quoted identifier fragment
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;

        const rows = await tx<{ status: ApplicationStatus }[]>`
          SELECT status FROM ${schema}.applications WHERE id = ${applicationId} FOR UPDATE
        `;
        const decision = decide(rows[0]?.status, requiredFrom, target);
        if (decision.kind !== 'APPLIED') return decision;

        await tx`
          UPDATE ${schema}.applications SET
            medical_reviewed_by_id = ${actor.officerId},
            medical_reviewed_at = now(),
            medical_fitness_status = ${fitnessStatus},
            status = ${target}::${schema}.application_status,
            updated_at = now()
          WHERE id = ${applicationId}
        `;
        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${applicationId},
            ${requiredFrom}::${schema}.application_status,
            ${target}::${schema}.application_status,
            ${`Medical review: ${fitnessStatus}`},
            ${actor.officerId},
            ${actor.correlationId}
          )
        `;

        return decision;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to apply medical review');
    }
  }

  async finalDecision(input: FinalDecisionInput): Promise<OfficerTransitionOutcome> {
    const { actor, applicationId, decision: verdict, notes } = input;
    const requiredFrom: ApplicationStatus = 'MEDICAL_REVIEW';
    const target: ApplicationStatus = verdict === 'SHORTLIST' ? 'FINAL_SHORTLIST' : 'REJECTED';
    const schema = sql(schemaForAgency(actor.agency));
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;

        const rows = await tx<{ status: ApplicationStatus }[]>`
          SELECT status FROM ${schema}.applications WHERE id = ${applicationId} FOR UPDATE
        `;
        const outcome = decide(rows[0]?.status, requiredFrom, target);
        if (outcome.kind !== 'APPLIED') return outcome;

        await tx`
          UPDATE ${schema}.applications SET
            final_decision_by_id = ${actor.officerId},
            final_decision_at = now(),
            final_decision_notes = ${notes},
            status = ${target}::${schema}.application_status,
            updated_at = now()
          WHERE id = ${applicationId}
        `;
        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${applicationId},
            ${requiredFrom}::${schema}.application_status,
            ${target}::${schema}.application_status,
            ${`Final decision: ${verdict}`},
            ${actor.officerId},
            ${actor.correlationId}
          )
        `;

        return outcome;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to apply final decision');
    }
  }

  async accept(input: AcceptInput): Promise<OfficerTransitionOutcome> {
    const { actor, applicationId } = input;
    const requiredFrom: ApplicationStatus = 'FINAL_SHORTLIST';
    const target: ApplicationStatus = 'ACCEPTED';
    const schema = sql(schemaForAgency(actor.agency));
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;

        const rows = await tx<{ status: ApplicationStatus }[]>`
          SELECT status FROM ${schema}.applications WHERE id = ${applicationId} FOR UPDATE
        `;
        const outcome = decide(rows[0]?.status, requiredFrom, target);
        if (outcome.kind !== 'APPLIED') return outcome;

        await tx`
          UPDATE ${schema}.applications SET
            status = 'ACCEPTED'::${schema}.application_status,
            updated_at = now()
          WHERE id = ${applicationId}
        `;
        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${applicationId},
            ${requiredFrom}::${schema}.application_status,
            ${target}::${schema}.application_status,
            'Accepted',
            ${actor.officerId},
            ${actor.correlationId}
          )
        `;

        return outcome;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to apply acceptance');
    }
  }

  async adjudicate(input: AdjudicateInput): Promise<AdjudicateOutcome> {
    const { actor, applicationId, decision, notes } = input;
    const schema = sql(schemaForAgency(actor.agency));
    try {
      return await sql.begin(async (tx): Promise<AdjudicateOutcome> => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;

        const rows = await tx<AdjudicableRow[]>`
          SELECT status, age_eligibility_status, academic_status, criminal_clearance_status,
                 applicant_id, campaign_id, category
          FROM ${schema}.applications WHERE id = ${applicationId} FOR UPDATE
        `;
        const current = rows[0];
        if (!current) return { kind: 'NOT_FOUND' };
        if (!ADJUDICABLE.has(current.status)) {
          return { kind: 'NOT_APPLICABLE', currentStatus: current.status };
        }

        let target: ApplicationStatus;
        if (decision === 'REJECT') {
          target = 'REJECTED';
        } else if (current.status === 'DOCUMENT_REVIEW_AMBER') {
          // CLEAR lifts the document hold; where the row lands is decided by
          // the SAME pure lifecycle that put every other status there — from
          // the baseline, on the row's recorded vetting evidence. All-pass →
          // GREEN (and the use case re-emits application.cleared, so the slot
          // lane runs exactly as for a green-lane clearance); gates still
          // pending → the furthest justified vetting stage, never a premature
          // green on unanswered evidence.
          target = deriveApplicationStatus('SUBMITTED', {
            ageStatus: current.age_eligibility_status,
            academicStatus: current.academic_status,
            criminalStatus: current.criminal_clearance_status,
          });
        } else {
          // CLEAR from ADJUDICATION_REVIEW: the officer dismisses the late
          // flag — restore the stage the row held when the flag arrived,
          // recorded on the append-only history (rls/0007 guarantees it).
          const prior = await tx<{ from_status: ApplicationStatus | null }[]>`
            SELECT from_status FROM ${schema}.application_status_history
            WHERE application_id = ${applicationId}
              AND to_status = 'ADJUDICATION_REVIEW'::${schema}.application_status
            ORDER BY performed_at DESC
            LIMIT 1
          `;
          const restored = prior[0]?.from_status;
          if (!restored) {
            // No recorded entry into the hold — nothing trustworthy to restore.
            return { kind: 'NOT_APPLICABLE', currentStatus: current.status };
          }
          target = restored;
        }

        if (target === current.status) return { kind: 'NO_CHANGE', currentStatus: current.status };

        await tx`
          UPDATE ${schema}.applications SET
            status = ${target}::${schema}.application_status,
            updated_at = now()
          WHERE id = ${applicationId}
        `;

        // A decision on an AMBER document hold is a HUMAN document review —
        // stamp the flagged rows with the reviewing officer (UUID sub) and the
        // decision. A late-disqualification hold is not a document decision,
        // so ADJUDICATION_REVIEW clears stamp nothing.
        if (current.status === 'DOCUMENT_REVIEW_AMBER') {
          await tx`
            UPDATE ${schema}.document_records SET
              human_reviewed_by_id = ${actor.officerId},
              human_reviewed_at = now(),
              human_review_decision = ${decision}
            WHERE application_id = ${applicationId}
              AND forensics_lane = 'AMBER'::${schema}.document_lane
              AND human_reviewed_by_id IS NULL
          `;
        }

        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${applicationId},
            ${current.status}::${schema}.application_status,
            ${target}::${schema}.application_status,
            ${
              // history reason is varchar(200) — keep the decision, bound the notes
              (notes === null ? `Adjudication: ${decision}` : `Adjudication: ${decision} — ${notes}`).slice(0, 200)
            },
            ${actor.officerId},
            ${actor.correlationId}
          )
        `;

        return {
          kind: 'APPLIED',
          fromStatus: current.status,
          toStatus: target,
          clearedToGreen: decision === 'CLEAR' && target === 'DOCUMENT_REVIEW_GREEN',
          applicantId: current.applicant_id,
          campaignId: current.campaign_id,
          category: current.category,
        };
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to apply adjudication');
    }
  }
}

/** Row shape the adjudicate transaction reads under FOR UPDATE. */
interface AdjudicableRow {
  readonly status: ApplicationStatus;
  readonly age_eligibility_status: AgeEligibilityStatus;
  readonly academic_status: AcademicEligibilityStatus;
  readonly criminal_clearance_status: CriminalClearanceStatus;
  readonly applicant_id: string;
  readonly campaign_id: string;
  readonly category: ApplicationCategory;
}

/**
 * Pure transition guard. Given the row's current status (or undefined when the
 * row is absent from the officer's schema), decide the outcome:
 *   • absent                   → NOT_FOUND (cross-agency guard / unknown app)
 *   • current === target       → NO_CHANGE (idempotent re-apply)
 *   • current !== requiredFrom  → NOT_APPLICABLE (out of order / already past)
 *   • otherwise                → APPLIED (requiredFrom → target)
 */
function decide(
  current: ApplicationStatus | undefined,
  requiredFrom: ApplicationStatus,
  target: ApplicationStatus,
): OfficerTransitionOutcome {
  if (current === undefined) return { kind: 'NOT_FOUND' };
  if (current === target) return { kind: 'NO_CHANGE', currentStatus: current };
  if (current !== requiredFrom) return { kind: 'NOT_APPLICABLE', currentStatus: current };
  return { kind: 'APPLIED', fromStatus: requiredFrom, toStatus: target };
}

/** Wrap any non-domain fault as ApplicationPersistenceError (idempotent). */
function wrap(cause: unknown, message: string): ApplicationPersistenceError {
  return cause instanceof ApplicationPersistenceError
    ? cause
    : new ApplicationPersistenceError(message, { cause });
}
