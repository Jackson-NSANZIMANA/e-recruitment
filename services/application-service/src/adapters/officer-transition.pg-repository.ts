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
//   4. accept() additionally takes the cross-agency accept-lock (ADR-014): a
//      FOR UPDATE + compare-and-set on the citizen's shared identity row in
//      public_core — one citizen, one acceptance, platform-wide. Already
//      locked (any agency) → CROSS_AGENCY_LOCKED, whole tx rolls back.
//   5. On APPLY: UPDATE the status + stamp the reviewer/decider columns, then
//      append an application_status_history row (append-only per rls/0007).
//
// The audit entry is emitted by the use case, not here — this adapter owns
// only the durable state change. Each method is self-contained (mirrors the
// system_service apply* methods on PgApplicationRepository); the only shared
// piece is the pure `decide` guard, which touches no I/O.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { SeparationOfDutiesConfig } from '../config.js';
import type {
  AcademicEligibilityStatus,
  AgeEligibilityStatus,
  Agency,
  ApplicationCategory,
  ApplicationStatus,
  CriminalClearanceStatus,
} from '@usrp/shared-types';
import type {
  AcceptInput,
  AcceptOutcome,
  AdjudicateInput,
  AdjudicateOutcome,
  FinalDecisionInput,
  MedicalReviewInput,
  OfficerTransitionOutcome,
  OfficerTransitionRepository,
} from '../ports/officer-transition-repository.js';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import { deriveApplicationStatus, type VettingEvidence } from '../domain/lifecycle.js';
import { adjudicationLanes, type AdjudicationLane } from '../domain/adjudication-lanes.js';

export class PgOfficerTransitionRepository implements OfficerTransitionRepository {
  readonly #sod: SeparationOfDutiesConfig;

  constructor(separationOfDuties?: SeparationOfDutiesConfig) {
    // Default = the roadmap's stated rule only; see config.ts.
    this.#sod = separationOfDuties ?? {
      finalDecisionExcludesMedicalReviewer: true,
      acceptExcludesFinalDecider: false,
    };
  }

  async medicalReview(input: MedicalReviewInput): Promise<OfficerTransitionOutcome> {
    const { actor, applicationId } = input;
    // THE LANE-MERGE POINT (ADR-012): medical review accepts the digital
    // lane's completed physical test AND the walk-in lane's — from here on
    // there is ONE funnel (medical → final → accept), so the future
    // cross-agency accept-lock covers walk-ins with no extra machinery.
    // (WALK_IN_PHYSICAL_TEST rows are RDF-only by construction — rnp/rcs lack
    // the enum values — so a CERTIFICATE-mode row can never be a walk-in.)
    const requiredFrom: readonly ApplicationStatus[] = [
      'PHYSICAL_TEST_COMPLETE',
      'WALK_IN_PHYSICAL_TEST',
    ];
    const positive = input.mode === 'BOARD'
      ? input.fitnessStatus === 'FIT'
      : input.certVerdict === 'CERT_VERIFIED';
    const target: ApplicationStatus = positive ? 'MEDICAL_REVIEW' : 'REJECTED';
    const reason = input.mode === 'BOARD'
      ? `Medical review: ${input.fitnessStatus}`
      : `Medical certificate: ${input.certVerdict}`;
    const schema = sql(schemaForAgency(actor.agency)); // quoted identifier fragment
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;

        const rows = await tx<{ status: ApplicationStatus }[]>`
          SELECT status FROM ${schema}.applications WHERE id = ${applicationId} FOR UPDATE
        `;
        const decision = decide(rows[0]?.status, requiredFrom, target);
        if (decision.kind !== 'APPLIED') return decision;

        if (input.mode === 'BOARD') {
          await tx`
            UPDATE ${schema}.applications SET
              medical_reviewed_by_id = ${actor.officerId},
              medical_reviewed_at = now(),
              medical_fitness_status = ${input.fitnessStatus},
              status = ${target}::${schema}.application_status,
              updated_at = now()
            WHERE id = ${applicationId}
          `;
        } else if (input.certVerdict === 'CERT_VERIFIED') {
          await tx`
            UPDATE ${schema}.applications SET
              medical_cert_verified = true,
              medical_cert_verified_at = now(),
              medical_cert_physician_name = ${input.physicianName},
              status = ${target}::${schema}.application_status,
              updated_at = now()
            WHERE id = ${applicationId}
          `;
        } else {
          // CERT_REJECTED: the REJECTED status + history row carry the
          // decision; medical_cert_verified stays false (never verified) —
          // see the port doc. The verifying officer lives in history
          // performed_by (cert columns have no *_by_id — RCS parity).
          await tx`
            UPDATE ${schema}.applications SET
              status = ${target}::${schema}.application_status,
              updated_at = now()
            WHERE id = ${applicationId}
          `;
        }
        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${applicationId},
            ${decision.fromStatus}::${schema}.application_status,
            ${target}::${schema}.application_status,
            ${reason},
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

        // Four-eyes: the officer who moved this application INTO medical
        // review (BOARD or CERTIFICATE — the history row is the one record
        // both modes share) may not also finalise it. Read under the same
        // row lock as the transition, so it cannot be raced.
        if (this.#sod.finalDecisionExcludesMedicalReviewer) {
          const reviewer = await tx<{ performed_by: string }[]>`
            SELECT performed_by::text AS performed_by
            FROM ${schema}.application_status_history
            WHERE application_id = ${applicationId} AND to_status = 'MEDICAL_REVIEW'
            ORDER BY performed_at DESC
            LIMIT 1
          `;
          if (reviewer[0]?.performed_by === actor.officerId) {
            return {
              kind: 'SEPARATION_OF_DUTIES',
              rule: 'FINAL_DECISION_EXCLUDES_MEDICAL_REVIEWER',
            };
          }
        }

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

  async accept(input: AcceptInput): Promise<AcceptOutcome> {
    const { actor, applicationId } = input;
    const requiredFrom: ApplicationStatus = 'FINAL_SHORTLIST';
    const target: ApplicationStatus = 'ACCEPTED';
    const schema = sql(schemaForAgency(actor.agency));
    try {
      return await sql.begin(async (tx): Promise<AcceptOutcome> => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;

        const rows = await tx<
          {
            status: ApplicationStatus;
            applicant_id: string;
            campaign_id: string;
            category: ApplicationCategory;
            final_decision_by_id: string | null;
          }[]
        >`
          SELECT status, applicant_id, campaign_id, category,
                 final_decision_by_id::text AS final_decision_by_id
          FROM ${schema}.applications
          WHERE id = ${applicationId} FOR UPDATE
        `;
        const current = rows[0];
        const outcome = decide(current?.status, requiredFrom, target);
        if (outcome.kind !== 'APPLIED') return outcome;
        if (current === undefined) return { kind: 'NOT_FOUND' }; // unreachable: decide() maps a missing row to NOT_FOUND

        // Four-eyes (policy-gated): the signer of the final decision may not
        // also enlist the applicant. Checked BEFORE the cross-agency lock so a
        // refusal never touches the shared identity row.
        if (
          this.#sod.acceptExcludesFinalDecider &&
          current.final_decision_by_id !== null &&
          current.final_decision_by_id === actor.officerId
        ) {
          return { kind: 'SEPARATION_OF_DUTIES', rule: 'ACCEPT_EXCLUDES_FINAL_DECIDER' };
        }

        // ── Cross-agency accept-lock (ADR-014) ──────────────────────
        // ONE citizen, ONE acceptance, platform-wide. The shared identity
        // row (unique per citizen) is the lock cell: FOR UPDATE serializes
        // concurrent accepts across ALL agencies (their application rows
        // live in different schemas, but they contend on this one row),
        // then a compare-and-set stamps the winner. The officer's own role
        // can read/update the row because the accepted citizen has an
        // application in this agency — exactly the pc_ai_<agency> RLS
        // predicate. A lost race or an existing lock (any agency, own
        // included — a second application of the same person) refuses the
        // acceptance and rolls the whole transaction back.
        const lock = await tx<{ cross_agency_locked_by_agency: Agency | null }[]>`
          SELECT cross_agency_locked_by_agency
          FROM public_core.applicant_identities
          WHERE id = ${current.applicant_id} FOR UPDATE
        `;
        const holder = lock[0]?.cross_agency_locked_by_agency;
        if (holder) return { kind: 'CROSS_AGENCY_LOCKED', lockedByAgency: holder };

        const stamped = await tx`
          UPDATE public_core.applicant_identities SET
            cross_agency_locked_at = now(),
            cross_agency_locked_by_agency = ${actor.agency},
            cross_agency_lock_reason = 'ACCEPTED'
          WHERE id = ${current.applicant_id} AND cross_agency_locked_at IS NULL
        `;
        if (stamped.count !== 1) {
          // Unreachable under the FOR UPDATE above (the row is ours until
          // commit) — kept as a fail-closed guard, mirroring the DB-side
          // all-or-nothing CHECK (rls/0013). Never accept on a suspect lock.
          return { kind: 'CROSS_AGENCY_LOCKED', lockedByAgency: actor.agency };
        }
        // ────────────────────────────────────────────────────────────

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

        // The identifiers APPLICATION_ACCEPTED needs (ADR-017) — read under
        // the same FOR UPDATE, so they describe exactly the accepted row.
        return {
          ...outcome,
          applicantId: current.applicant_id,
          campaignId: current.campaign_id,
          category: current.category,
        };
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to apply acceptance');
    }
  }

  async adjudicate(input: AdjudicateInput): Promise<AdjudicateOutcome> {
    const { actor, applicationId, decision, notes, lane } = input;
    const schema = sql(schemaForAgency(actor.agency));
    try {
      return await sql.begin(async (tx): Promise<AdjudicateOutcome> => {
        await tx`SET LOCAL ROLE ${sql(actor.dbRole)}`;

        const rows = await tx<AdjudicableRow[]>`
          SELECT status, age_eligibility_status, academic_status, criminal_clearance_status,
                 academic_eligibility_detail,
                 applicant_id, campaign_id, category
          FROM ${schema}.applications WHERE id = ${applicationId} FOR UPDATE
        `;
        const current = rows[0];
        if (!current) return { kind: 'NOT_FOUND' };

        // WHICH hold is this verdict about (evaluation D10)? Read from the row,
        // never from the queue entry the officer was looking at: the queue is a
        // snapshot, and a decision made against a stale copy must not silently
        // apply to a different hold.
        let evidence: VettingEvidence = {
          ageStatus: current.age_eligibility_status,
          academicStatus: current.academic_status,
          criminalStatus: current.criminal_clearance_status,
        };
        const held = adjudicationLanes({
          status: current.status,
          criminalStatus: current.criminal_clearance_status,
          academicStatus: current.academic_status,
          academicDetail: current.academic_eligibility_detail,
        });
        const decided: AdjudicationLane | undefined =
          lane ?? (held.length === 1 ? held[0] : undefined);
        if (decided === undefined || !held.includes(decided)) {
          // Nothing here needs a human, or the caller named a lane this row is
          // not held in — and the refusal says which lanes it IS held in.
          return { kind: 'NOT_APPLICABLE', currentStatus: current.status, heldLanes: held };
        }

        let target: ApplicationStatus;
        if (decision === 'REJECT') {
          // A rejection is a decision about the APPLICATION, not a verdict
          // about the dimension: the registry said "a human must judge", not
          // "guilty", so the dimension column keeps the evidence it had.
          target = 'REJECTED';
        } else if (decided === 'DOCUMENT') {
          if (current.status === 'DOCUMENT_REVIEW_AMBER') {
            // CLEAR lifts the document hold; where the row lands is decided by
            // the SAME pure lifecycle that put every other status there — from
            // the baseline, on the row's recorded vetting evidence. All-pass →
            // GREEN (and the use case re-emits application.cleared, so the slot
            // lane runs exactly as for a green-lane clearance); gates still
            // pending → the furthest justified vetting stage, never a premature
            // green on unanswered evidence.
            target = deriveApplicationStatus('SUBMITTED', evidence);
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
              return { kind: 'NOT_APPLICABLE', currentStatus: current.status, heldLanes: held };
            }
            target = restored;
          }
        } else {
          // CRIMINAL / ACADEMIC (evaluation D10): a human decides a dimension
          // the automatic gate could not settle. CLEAR records the verdict the
          // gate would have recorded; the lifecycle then places the row exactly
          // as it would for an automatic pass.
          if (decided === 'CRIMINAL') {
            await tx`
              UPDATE ${schema}.applications SET
                criminal_clearance_status = 'CLEARED'::${schema}.criminal_clearance_status,
                criminal_clearance_at = now(),
                updated_at = now()
              WHERE id = ${applicationId}
            `;
            evidence = { ...evidence, criminalStatus: 'CLEARED' };
          } else {
            await tx`
              UPDATE ${schema}.applications SET
                academic_status = 'ELIGIBLE'::${schema}.academic_eligibility_status,
                updated_at = now()
              WHERE id = ${applicationId}
            `;
            evidence = { ...evidence, academicStatus: 'ELIGIBLE' };
          }
          // A verdict on ONE dimension never lifts a hold in ANOTHER: if a
          // document hold (or a second lane) is still open, the top-level status
          // does not move — otherwise a criminal CLEAR would walk a row past a
          // document review no human has performed.
          target = held.some((other) => other !== decided)
            ? current.status
            : deriveApplicationStatus(current.status, evidence);
        }

        // The DOCUMENT lane keeps its idempotent no-op; the dimension lanes
        // always report APPLIED, because the verdict itself is the write (the
        // status may legitimately stay put while another hold is pending).
        if (target === current.status && decided === 'DOCUMENT') {
          return { kind: 'NO_CHANGE', currentStatus: current.status };
        }

        if (target !== current.status) {
          await tx`
            UPDATE ${schema}.applications SET
              status = ${target}::${schema}.application_status,
              updated_at = now()
            WHERE id = ${applicationId}
          `;
        }

        // A decision on an AMBER document hold is a HUMAN document review —
        // stamp the flagged rows with the reviewing officer (UUID sub) and the
        // decision. No other lane is a document decision, so nothing else stamps
        // document_records.
        if (decided === 'DOCUMENT' && current.status === 'DOCUMENT_REVIEW_AMBER') {
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

        if (target !== current.status) {
          await tx`
            INSERT INTO ${schema}.application_status_history
              (application_id, from_status, to_status, reason, performed_by, correlation_id)
            VALUES (
              ${applicationId},
              ${current.status}::${schema}.application_status,
              ${target}::${schema}.application_status,
              ${
                // history reason is varchar(200) — keep the decision AND the
                // lane (an officer reading the trail must know which hold the
                // decision was about), and bound the notes.
                (notes === null
                  ? `Adjudication: ${decision} (${decided})`
                  : `Adjudication: ${decision} (${decided}) — ${notes}`
                ).slice(0, 200)
              },
              ${actor.officerId},
              ${actor.correlationId}
            )
          `;
        }

        return {
          kind: 'APPLIED',
          lane: decided,
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
  /** jsonb; only `failureCode` is read (the NESA human-review hold). */
  readonly academic_eligibility_detail: Record<string, unknown> | null;
  readonly applicant_id: string;
  readonly campaign_id: string;
  readonly category: ApplicationCategory;
}

/**
 * Pure transition guard. Given the row's current status (or undefined when the
 * row is absent from the officer's schema), decide the outcome:
 *   • absent                     → NOT_FOUND (cross-agency guard / unknown app)
 *   • current === target         → NO_CHANGE (idempotent re-apply)
 *   • current ∉ requiredFrom     → NOT_APPLICABLE (out of order / already past)
 *   • otherwise                  → APPLIED (current → target)
 * `requiredFrom` may be a single status (the common case) or a list — the
 * medical review is the lane-merge point (ADR-012): it accepts the digital
 * lane's PHYSICAL_TEST_COMPLETE and the walk-in lane's WALK_IN_PHYSICAL_TEST.
 * APPLIED reports the ACTUAL from-status so history records the true edge.
 */
function decide(
  current: ApplicationStatus | undefined,
  requiredFrom: ApplicationStatus | readonly ApplicationStatus[],
  target: ApplicationStatus,
): OfficerTransitionOutcome {
  if (current === undefined) return { kind: 'NOT_FOUND' };
  if (current === target) return { kind: 'NO_CHANGE', currentStatus: current };
  const allowed: readonly ApplicationStatus[] = Array.isArray(requiredFrom)
    ? requiredFrom
    : [requiredFrom as ApplicationStatus];
  if (!allowed.includes(current)) return { kind: 'NOT_APPLICABLE', currentStatus: current };
  return { kind: 'APPLIED', fromStatus: current, toStatus: target };
}

/** Wrap any non-domain fault as ApplicationPersistenceError (idempotent). */
function wrap(cause: unknown, message: string): ApplicationPersistenceError {
  return cause instanceof ApplicationPersistenceError
    ? cause
    : new ApplicationPersistenceError(message, { cause });
}
