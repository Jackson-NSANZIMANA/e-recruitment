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
import type { ApplicationStatus } from '@usrp/shared-types';
import type {
  AcceptInput,
  FinalDecisionInput,
  MedicalReviewInput,
  OfficerTransitionOutcome,
  OfficerTransitionRepository,
} from '../ports/officer-transition-repository.js';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';

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
