// ══════════════════════════════════════════════════════════════════
// application-service — ApplicationRepository adapter (PostgreSQL)
//
// Files an application into the OWNING agency's isolated ops schema, as
// usrp_system_service, in one transaction:
//
//   1. Mint the processing code atomically from that agency's sequence:
//      'RDF-' || lpad(nextval('rdf_ops.processing_code_seq'), 5, '0').
//      nextval is contention-free, so concurrent submissions never collide.
//   2. INSERT the applications row (status SUBMITTED, submitted_at now()).
//   3. INSERT the initial application_status_history row (null → SUBMITTED)
//      — the immutable trail's first entry, carrying the correlation id.
//
// The agency selects the schema; only three agencies exist and each maps
// to a fixed, hard-coded ops schema — no user input ever reaches an
// identifier. The category/status values are cast to that schema's enum
// types. Both statements share the transaction: a failure on either rolls
// back the whole submission, so an application never exists without its
// opening history row.
// ══════════════════════════════════════════════════════════════════

import { sql, asJsonb } from '@usrp/shared-database';
import { APPLICATION_STATUSES, type ApplicationStatus } from '@usrp/shared-types';
import type {
  ApplicationRepository,
  ApplyForensicsOutcome,
  ApplyNotificationOutcome,
  ApplyPhysicalTestOutcome,
  ApplySlotOutcome,
  ApplyVettingOutcome,
  CreateApplicationInput,
  CreateApplicationResult,
  ForensicsRoutingResult,
  NotificationDeliveryResult,
  PhysicalTestCompleteResult,
  SlotAssignmentResult,
  VettingResult,
} from '../ports/application-repository.js';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { AGENCY_TARGET } from '../domain/agency-schema.js';
import { deriveApplicationStatus } from '../domain/lifecycle.js';

const SYSTEM_ROLE = 'usrp_system_service';

/** The lifecycle columns the projection reads under FOR UPDATE. */
interface ApplicationStateRow {
  readonly status: ApplicationStatus;
  readonly age_eligibility_status: import('@usrp/shared-types').AgeEligibilityStatus;
  readonly academic_status: import('@usrp/shared-types').AcademicEligibilityStatus;
  readonly criminal_clearance_status: import('@usrp/shared-types').CriminalClearanceStatus;
  readonly applicant_id: string;
  readonly campaign_id: string;
  readonly category: import('@usrp/shared-types').ApplicationCategory;
}

export class PgApplicationRepository implements ApplicationRepository {
  async createApplication(input: CreateApplicationInput): Promise<CreateApplicationResult> {
    const target = AGENCY_TARGET[input.agency];
    const schema = sql(target.schema); // quoted identifier fragment
    const seqName = `${target.schema}.processing_code_seq`;

    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        // 1 + 2: mint the code and insert the application atomically.
        const inserted = await tx<{ id: string; processing_code: string }[]>`
          INSERT INTO ${schema}.applications
            (processing_code, applicant_id, campaign_id, category, status,
             nesa_index_number, hec_registration_number, submitted_at)
          VALUES (
            ${target.codePrefix} || '-' || lpad(nextval(${seqName}::regclass)::text, 5, '0'),
            ${input.applicantId},
            ${input.campaignId},
            ${input.category}::${schema}.application_category,
            'SUBMITTED',
            ${input.nesaIndexNumber},
            ${input.hecRegistrationNumber},
            now()
          )
          RETURNING id, processing_code
        `;
        const row = inserted[0];
        if (!row) {
          throw new ApplicationPersistenceError('Application insert returned no row');
        }

        // 3: the immutable trail's opening entry (null → SUBMITTED).
        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${row.id},
            NULL,
            'SUBMITTED',
            'Application submitted via front door',
            'SYSTEM',
            ${input.correlationId}
          )
        `;

        return { applicationId: row.id, processingCode: row.processing_code };
      });
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to create application', { cause });
    }
  }

  async applyVettingResult(result: VettingResult): Promise<ApplyVettingOutcome> {
    const target = AGENCY_TARGET[result.agency];
    const schema = sql(target.schema); // quoted identifier fragment

    try {
      return await sql.begin(async (tx): Promise<ApplyVettingOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        // Lock the row for the life of the transaction. All events for one
        // applicant share a Kafka partition (keyed by applicantId) so they are
        // already serialized per applicant; FOR UPDATE additionally guards
        // against rebalance/redelivery races and any second process.
        const rows = await tx<ApplicationStateRow[]>`
          SELECT status, age_eligibility_status, academic_status, criminal_clearance_status,
                 applicant_id, campaign_id, category
          FROM ${schema}.applications
          WHERE id = ${result.applicationId}
          FOR UPDATE
        `;
        const current = rows[0];
        // 0 rows ⇒ this application does not exist in THIS agency's schema.
        // The engine cannot stop a cross-agency mis-route (no RLS on ops
        // applications), so we assert it here rather than silently succeed.
        if (!current) return { kind: 'NOT_FOUND' };

        // Post-update per-dimension verdicts (only the projected one changes).
        const newAge =
          result.dimension === 'AGE' ? result.ageStatus : current.age_eligibility_status;
        const newAcademic =
          result.dimension === 'ACADEMIC' ? result.academicStatus : current.academic_status;
        const newCriminal =
          result.dimension === 'CRIMINAL' ? result.criminalStatus : current.criminal_clearance_status;

        const columnChanged =
          result.dimension === 'AGE'
            ? newAge !== current.age_eligibility_status
            : result.dimension === 'ACADEMIC'
              ? newAcademic !== current.academic_status
              : newCriminal !== current.criminal_clearance_status;

        const toStatus = deriveApplicationStatus(current.status, {
          ageStatus: newAge,
          academicStatus: newAcademic,
          criminalStatus: newCriminal,
        });
        const statusChanged = toStatus !== current.status;

        // Idempotent redelivery: nothing to do, write nothing.
        if (!columnChanged && !statusChanged) return { kind: 'NO_CHANGE' };

        if (result.dimension === 'AGE') {
          await tx`
            UPDATE ${schema}.applications SET
              age_eligibility_status = ${newAge}::${schema}.age_eligibility_status,
              age_verified_at = now(),
              age_eligibility_detail = ${tx.json(asJsonb(result.detail))},
              status = ${toStatus}::${schema}.application_status,
              updated_at = now()
            WHERE id = ${result.applicationId}
          `;
        } else if (result.dimension === 'ACADEMIC') {
          const verifiedAtCol =
            result.verifiedVia === 'NESA' ? sql('nesa_verified_at') : sql('hec_verified_at');
          const requestIdCol =
            result.verifiedVia === 'NESA'
              ? sql('nesa_verification_request_id')
              : sql('hec_verification_request_id');
          await tx`
            UPDATE ${schema}.applications SET
              academic_status = ${newAcademic}::${schema}.academic_eligibility_status,
              ${verifiedAtCol} = now(),
              ${requestIdCol} = ${result.requestId},
              academic_eligibility_detail = ${tx.json(asJsonb(result.detail))},
              status = ${toStatus}::${schema}.application_status,
              updated_at = now()
            WHERE id = ${result.applicationId}
          `;
        } else {
          // applied_criminal_threshold exists only on rnp_ops.applications.
          const thresholdAssign =
            result.agency === 'RNP'
              ? sql`, applied_criminal_threshold = ${result.appliedThreshold}`
              : sql``;
          await tx`
            UPDATE ${schema}.applications SET
              criminal_clearance_status = ${newCriminal}::${schema}.criminal_clearance_status,
              criminal_clearance_at = now(),
              rib_request_id = ${result.ribRequestId}${thresholdAssign},
              status = ${toStatus}::${schema}.application_status,
              updated_at = now()
            WHERE id = ${result.applicationId}
          `;
        }

        // The immutable trail records TOP-LEVEL status transitions only; the
        // per-dimension column change is captured by the audit event upstream.
        if (statusChanged) {
          await tx`
            INSERT INTO ${schema}.application_status_history
              (application_id, from_status, to_status, reason, performed_by, correlation_id)
            VALUES (
              ${result.applicationId},
              ${current.status}::${schema}.application_status,
              ${toStatus}::${schema}.application_status,
              ${`Projected ${result.dimension} verdict`},
              'application-service',
              ${result.correlationId}
            )
          `;
        }

        return {
          kind: 'APPLIED',
          dimension: result.dimension,
          fromStatus: current.status,
          toStatus,
          statusChanged,
          applicantId: current.applicant_id,
          campaignId: current.campaign_id,
          category: current.category,
        };
      });
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to apply vetting result', { cause });
    }
  }

  async applySlotAssignment(result: SlotAssignmentResult): Promise<ApplySlotOutcome> {
    const target = AGENCY_TARGET[result.agency];
    const schema = sql(target.schema);

    try {
      return await sql.begin(async (tx): Promise<ApplySlotOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        const rows = await tx<{ status: ApplicationStatus; applicant_id: string }[]>`
          SELECT status, applicant_id
          FROM ${schema}.applications
          WHERE id = ${result.applicationId}
          FOR UPDATE
        `;
        const current = rows[0];
        // 0 rows ⇒ not in THIS agency's schema (mis-route / unknown) — no RLS on
        // ops applications, so assert it here rather than silently succeed.
        if (!current) return { kind: 'NOT_FOUND' };

        // Already scheduled ⇒ idempotent redelivery, write nothing.
        if (current.status === 'SLOT_ASSIGNED') return { kind: 'NO_CHANGE' };

        // A slot is only assignable from the positive eligibility terminal. Any
        // other status (still vetting, rejected, withdrawn, further downstream)
        // is a hold — never force a row backward or sideways into scheduling.
        if (current.status !== 'DOCUMENT_REVIEW_GREEN') {
          return { kind: 'NOT_ASSIGNABLE', currentStatus: current.status };
        }

        await tx`
          UPDATE ${schema}.applications SET
            venue_assignment_id = ${result.venueAssignmentId},
            assigned_district = ${result.assignedDistrict},
            assigned_venue_name = ${result.assignedVenueName},
            physical_test_scheduled_at = ${result.examDate}::date,
            qr_invitation_code = ${result.qrInvitationCode},
            qr_invitation_issued_at = now(),
            status = 'SLOT_ASSIGNED'::${schema}.application_status,
            updated_at = now()
          WHERE id = ${result.applicationId}
        `;

        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${result.applicationId},
            'DOCUMENT_REVIEW_GREEN'::${schema}.application_status,
            'SLOT_ASSIGNED'::${schema}.application_status,
            'Exam slot assigned',
            'application-service',
            ${result.correlationId}
          )
        `;

        return {
          kind: 'APPLIED',
          fromStatus: 'DOCUMENT_REVIEW_GREEN',
          toStatus: 'SLOT_ASSIGNED',
          applicantId: current.applicant_id,
        };
      });
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to apply slot assignment', { cause });
    }
  }

  async applyNotificationDelivery(
    result: NotificationDeliveryResult,
  ): Promise<ApplyNotificationOutcome> {
    const schema = sql(AGENCY_TARGET[result.agency].schema);
    const scheduledRank = APPLICATION_STATUSES.indexOf('PHYSICAL_TEST_SCHEDULED');

    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        const rows = await tx<{ status: ApplicationStatus; applicant_id: string }[]>`
          SELECT status, applicant_id
          FROM ${schema}.applications
          WHERE id = ${result.applicationId}
          FOR UPDATE
        `;
        const current = rows[0];
        if (!current) return { kind: 'NOT_FOUND' };

        // Idempotent: already scheduled (or beyond) — refresh the recorded SMS
        // status only, never regress or re-append history.
        if (APPLICATION_STATUSES.indexOf(current.status) >= scheduledRank) {
          await tx`
            UPDATE ${schema}.applications SET
              sms_notification_sent_at = now(),
              sms_notification_status = ${result.deliveryStatus},
              updated_at = now()
            WHERE id = ${result.applicationId}
          `;
          return { kind: 'NO_CHANGE' };
        }

        // The invitation only advances the row from the slot terminal. Any
        // earlier (still vetting/awaiting slot) or terminal status is a hold.
        if (current.status !== 'SLOT_ASSIGNED') {
          return { kind: 'NOT_APPLICABLE', currentStatus: current.status };
        }

        await tx`
          UPDATE ${schema}.applications SET
            sms_notification_sent_at = now(),
            sms_notification_status = ${result.deliveryStatus},
            status = 'PHYSICAL_TEST_SCHEDULED'::${schema}.application_status,
            updated_at = now()
          WHERE id = ${result.applicationId}
        `;

        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${result.applicationId},
            'SLOT_ASSIGNED'::${schema}.application_status,
            'PHYSICAL_TEST_SCHEDULED'::${schema}.application_status,
            'Slot invitation delivered',
            'application-service',
            ${result.correlationId}
          )
        `;

        return {
          kind: 'APPLIED',
          fromStatus: 'SLOT_ASSIGNED',
          toStatus: 'PHYSICAL_TEST_SCHEDULED',
          applicantId: current.applicant_id,
        };
      });
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to apply notification delivery', { cause });
    }
  }

  async applyPhysicalTestComplete(
    result: PhysicalTestCompleteResult,
  ): Promise<ApplyPhysicalTestOutcome> {
    const schema = sql(AGENCY_TARGET[result.agency].schema);
    const completeRank = APPLICATION_STATUSES.indexOf('PHYSICAL_TEST_COMPLETE');

    try {
      return await sql.begin(async (tx): Promise<ApplyPhysicalTestOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        const rows = await tx<{ status: ApplicationStatus; applicant_id: string; is_walk_in: boolean }[]>`
          SELECT status, applicant_id, is_walk_in
          FROM ${schema}.applications
          WHERE id = ${result.applicationId}
          FOR UPDATE
        `;
        const current = rows[0];
        // 0 rows ⇒ not in THIS agency's schema (mis-route / unknown).
        if (!current) return { kind: 'NOT_FOUND' };

        // ── Walk-in lane (ADR-012) — decided by the ROW's own is_walk_in, not
        // the event's claim. Handled BEFORE the rank-based idempotency check:
        // WALK_IN_* ranks after the whole digital ladder, so that check would
        // misread every walk-in row as "already complete". The lane-local
        // transition is WALK_IN_ON_SITE_VETTING → WALK_IN_PHYSICAL_TEST.
        if (current.is_walk_in) {
          if (current.status === 'WALK_IN_PHYSICAL_TEST') return { kind: 'NO_CHANGE' };
          // Not yet vetted on-site, already merged into the main funnel
          // (MEDICAL_REVIEW onward), rejected, or held — nothing to write.
          if (current.status !== 'WALK_IN_ON_SITE_VETTING') {
            return { kind: 'NOT_APPLICABLE', currentStatus: current.status };
          }
          // Same concurrent-capture HOLD as the digital lane (ADR-010 §3).
          const walkInConflict = await tx<{ one: number }[]>`
            SELECT 1 AS one
            FROM ${schema}.physical_test_scores
            WHERE application_id = ${result.applicationId} AND sync_conflict_detected = true
            LIMIT 1
          `;
          if (walkInConflict[0]) return { kind: 'CONFLICT_HELD' };

          // NO biometric precondition (ADR-012 waiver): the biometric gate
          // verifies a signed slot-invitation QR that a walk-in cannot possess
          // — their identity was NIDA-verified IN PERSON by the registering
          // officer at this same venue. On-site biometric enrolment is a
          // flagged follow-on, not silently assumed done.
          const walkInScore = await tx<{ id: string }[]>`
            SELECT id
            FROM ${schema}.physical_test_scores
            WHERE application_id = ${result.applicationId}
              AND signed_payload_hash = ${result.signedPayloadHash}
            ORDER BY captured_at DESC
            LIMIT 1
          `;
          const walkInScoreId = walkInScore[0]?.id;
          if (!walkInScoreId) return { kind: 'SCORE_NOT_FOUND' };

          await tx`
            UPDATE ${schema}.applications SET
              physical_test_completed_at = now(),
              physical_test_score_id = ${walkInScoreId},
              status = 'WALK_IN_PHYSICAL_TEST'::${schema}.application_status,
              updated_at = now()
            WHERE id = ${result.applicationId}
          `;
          await tx`
            INSERT INTO ${schema}.application_status_history
              (application_id, from_status, to_status, reason, performed_by, correlation_id)
            VALUES (
              ${result.applicationId},
              'WALK_IN_ON_SITE_VETTING'::${schema}.application_status,
              'WALK_IN_PHYSICAL_TEST'::${schema}.application_status,
              'Walk-in physical-test score captured',
              'application-service',
              ${result.correlationId}
            )
          `;
          return {
            kind: 'APPLIED',
            fromStatus: 'WALK_IN_ON_SITE_VETTING',
            toStatus: 'WALK_IN_PHYSICAL_TEST',
            applicantId: current.applicant_id,
            physicalTestScoreId: walkInScoreId,
          };
        }

        // Idempotent: already complete (or beyond) — write nothing.
        if (APPLICATION_STATUSES.indexOf(current.status) >= completeRank) {
          return { kind: 'NO_CHANGE' };
        }

        // A score only completes a row that is at the scheduled stage. Anything
        // earlier (still vetting/awaiting slot) or terminal is a hold.
        if (current.status !== 'PHYSICAL_TEST_SCHEDULED') {
          return { kind: 'NOT_APPLICABLE', currentStatus: current.status };
        }

        // Never complete while a concurrent-capture conflict is unresolved
        // (ADR-010 §3). This makes the HOLD an engine guarantee even if a clean
        // score's event was ordered before the conflicting one was flagged; the
        // resolve endpoint clears the flag, then the re-emitted event advances.
        const conflict = await tx<{ one: number }[]>`
          SELECT 1 AS one
          FROM ${schema}.physical_test_scores
          WHERE application_id = ${result.applicationId} AND sync_conflict_detected = true
          LIMIT 1
        `;
        if (conflict[0]) return { kind: 'CONFLICT_HELD' };

        // Biometric-pass precondition (ADR-010 §4): the applicant must have
        // cleared the exam-day check-in. No verified biometric ⇒ hold.
        const bio = await tx<{ biometric_verified_at: Date | null }[]>`
          SELECT biometric_verified_at
          FROM public_core.applicant_identities
          WHERE id = ${current.applicant_id}
        `;
        if (!bio[0] || bio[0].biometric_verified_at === null) {
          return { kind: 'BIOMETRIC_NOT_VERIFIED' };
        }

        // Resolve the accepted score row from the event's metrics hash. The
        // event carries the hash, not the row id (field-sync owns the id).
        const scoreRows = await tx<{ id: string }[]>`
          SELECT id
          FROM ${schema}.physical_test_scores
          WHERE application_id = ${result.applicationId}
            AND signed_payload_hash = ${result.signedPayloadHash}
          ORDER BY captured_at DESC
          LIMIT 1
        `;
        const scoreId = scoreRows[0]?.id;
        if (!scoreId) return { kind: 'SCORE_NOT_FOUND' };

        await tx`
          UPDATE ${schema}.applications SET
            physical_test_completed_at = now(),
            physical_test_score_id = ${scoreId},
            status = 'PHYSICAL_TEST_COMPLETE'::${schema}.application_status,
            updated_at = now()
          WHERE id = ${result.applicationId}
        `;

        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${result.applicationId},
            'PHYSICAL_TEST_SCHEDULED'::${schema}.application_status,
            'PHYSICAL_TEST_COMPLETE'::${schema}.application_status,
            'Physical-test score captured',
            'application-service',
            ${result.correlationId}
          )
        `;

        return {
          kind: 'APPLIED',
          fromStatus: 'PHYSICAL_TEST_SCHEDULED',
          toStatus: 'PHYSICAL_TEST_COMPLETE',
          applicantId: current.applicant_id,
          physicalTestScoreId: scoreId,
        };
      });
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to apply physical-test completion', { cause });
    }
  }

  async applyForensicsRouting(result: ForensicsRoutingResult): Promise<ApplyForensicsOutcome> {
    const schema = sql(AGENCY_TARGET[result.agency].schema);
    const slotRank = APPLICATION_STATUSES.indexOf('SLOT_ASSIGNED');
    const amberRank = APPLICATION_STATUSES.indexOf('DOCUMENT_REVIEW_AMBER');

    try {
      return await sql.begin(async (tx): Promise<ApplyForensicsOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        const rows = await tx<{ status: ApplicationStatus; applicant_id: string }[]>`
          SELECT status, applicant_id
          FROM ${schema}.applications
          WHERE id = ${result.applicationId}
          FOR UPDATE
        `;
        const current = rows[0];
        // 0 rows ⇒ not in THIS agency's schema (mis-route / unknown).
        if (!current) return { kind: 'NOT_FOUND' };

        // Terminal rows are never routed (the verdict stays in document_records).
        if (current.status === 'REJECTED' || current.status === 'WITHDRAWN' || current.status === 'ACCEPTED') {
          return { kind: 'NOT_APPLICABLE', currentStatus: current.status };
        }

        // GREEN never moves the status; a redelivered verdict on an
        // already-held/adjudicating row changes nothing (idempotent).
        const currentRank = APPLICATION_STATUSES.indexOf(current.status);
        let target: ApplicationStatus | null = null;
        if (result.lane === 'RED') {
          // ADR-011 lane policy: hostile document → autonomous reject while
          // still pre-slot, human adjudication once the applicant is cleared.
          target = currentRank >= slotRank ? 'ADJUDICATION_REVIEW' : 'REJECTED';
        } else if (result.lane === 'AMBER') {
          if (currentRank >= slotRank) target = 'ADJUDICATION_REVIEW';
          else if (currentRank < amberRank) target = 'DOCUMENT_REVIEW_AMBER';
          // already AMBER (or between AMBER and slot — nothing to hold) → no-op
        }
        if (target === null || target === current.status) return { kind: 'NO_CHANGE' };

        await tx`
          UPDATE ${schema}.applications SET
            status = ${target}::${schema}.application_status,
            updated_at = now()
          WHERE id = ${result.applicationId}
        `;
        await tx`
          INSERT INTO ${schema}.application_status_history
            (application_id, from_status, to_status, reason, performed_by, correlation_id)
          VALUES (
            ${result.applicationId},
            ${current.status}::${schema}.application_status,
            ${target}::${schema}.application_status,
            ${`Document forensics: ${result.lane} lane (document ${result.documentId})`},
            'application-service',
            ${result.correlationId}
          )
        `;

        return {
          kind: 'APPLIED',
          fromStatus: current.status,
          toStatus: target,
          applicantId: current.applicant_id,
        };
      });
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to apply forensics routing', { cause });
    }
  }
}
