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

import { sql } from '@usrp/shared-database';
import type { ApplicationStatus } from '@usrp/shared-types';
import type {
  ApplicationRepository,
  ApplyVettingOutcome,
  CreateApplicationInput,
  CreateApplicationResult,
  VettingResult,
} from '../ports/application-repository.js';
import { ApplicationPersistenceError } from '../domain/application.errors.js';
import { AGENCY_TARGET } from '../domain/agency-schema.js';
import { deriveApplicationStatus } from '../domain/lifecycle.js';

const SYSTEM_ROLE = 'usrp_system_service';

/** The lifecycle columns the projection reads under FOR UPDATE. */
interface ApplicationStateRow {
  readonly status: ApplicationStatus;
  readonly academic_status: import('@usrp/shared-types').AcademicEligibilityStatus;
  readonly criminal_clearance_status: import('@usrp/shared-types').CriminalClearanceStatus;
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
          SELECT status, academic_status, criminal_clearance_status
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
        const newAcademic =
          result.dimension === 'ACADEMIC' ? result.academicStatus : current.academic_status;
        const newCriminal =
          result.dimension === 'CRIMINAL' ? result.criminalStatus : current.criminal_clearance_status;

        const columnChanged =
          result.dimension === 'ACADEMIC'
            ? newAcademic !== current.academic_status
            : newCriminal !== current.criminal_clearance_status;

        const toStatus = deriveApplicationStatus(current.status, {
          academicStatus: newAcademic,
          criminalStatus: newCriminal,
        });
        const statusChanged = toStatus !== current.status;

        // Idempotent redelivery: nothing to do, write nothing.
        if (!columnChanged && !statusChanged) return { kind: 'NO_CHANGE' };

        if (result.dimension === 'ACADEMIC') {
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
              academic_eligibility_detail = ${JSON.stringify(result.detail)}::jsonb,
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
        };
      });
    } catch (cause) {
      if (cause instanceof ApplicationPersistenceError) throw cause;
      throw new ApplicationPersistenceError('Failed to apply vetting result', { cause });
    }
  }
}
