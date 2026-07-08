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
import type { Agency } from '@usrp/shared-types';
import type {
  ApplicationRepository,
  CreateApplicationInput,
  CreateApplicationResult,
} from '../ports/application-repository.js';
import { ApplicationPersistenceError } from '../domain/application.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';

/** Per-agency write target — fixed mapping, never derived from user input. */
interface AgencyTarget {
  readonly schema: 'rdf_ops' | 'rnp_ops' | 'rcs_ops';
  readonly codePrefix: 'RDF' | 'RNP' | 'RCS';
}

const AGENCY_TARGET: Readonly<Record<Agency, AgencyTarget>> = {
  RDF: { schema: 'rdf_ops', codePrefix: 'RDF' },
  RNP: { schema: 'rnp_ops', codePrefix: 'RNP' },
  RCS: { schema: 'rcs_ops', codePrefix: 'RCS' },
};

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
}
