// ══════════════════════════════════════════════════════════════════
// background-vetting-service — ClearanceVerificationRepository (PostgreSQL)
//
// The ONLY write path is <agency>_ops.record_clearance_verification (rls/0040),
// a SECURITY DEFINER command function that re-checks the caller is usrp_app
// acting as usrp_vetting_service, that the application exists in THIS agency,
// and the shape of every column. This adapter assumes the service role
// transaction-locally; the table itself grants it nothing.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { schemaForAgency } from './agency-schema.js';
import type {
  ClearanceVerificationRecord,
  ClearanceVerificationRepository,
  RecordVerificationResult,
} from '../ports/clearance-verification.repository.js';

const SERVICE_ROLE = 'usrp_vetting_service';

export class VerificationPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VerificationPersistenceError';
  }
}

export class PgClearanceVerificationRepository implements ClearanceVerificationRepository {
  async record(input: ClearanceVerificationRecord): Promise<RecordVerificationResult> {
    const schema = sql(schemaForAgency(input.agency));
    try {
      return await sql.begin(async (tx): Promise<RecordVerificationResult> => {
        await tx`SET LOCAL ROLE ${sql(SERVICE_ROLE)}`;
        const rows = await tx<{ result: { outcome?: string } }[]>`
          SELECT ${schema}.record_clearance_verification(
            ${input.applicationId}::uuid,
            ${input.applicantId}::uuid,
            ${input.referenceHmac},
            ${input.referenceLast4},
            ${input.certificateType},
            ${input.issuedOn}::date,
            ${input.outcome},
            ${input.failureCode},
            ${sql.array([...input.reviewReasons])}::text[],
            ${input.binding === null ? null : JSON.stringify(input.binding)}::text::jsonb,
            ${input.requestId},
            ${input.correlationId}
          ) AS result
        `;
        const outcome = rows[0]?.result.outcome;
        if (outcome === 'RECORDED' || outcome === 'ALREADY_RECORDED') return outcome;
        throw new VerificationPersistenceError(`record_clearance_verification refused (${outcome ?? 'no answer'})`);
      });
    } catch (cause) {
      if (cause instanceof VerificationPersistenceError) throw cause;
      throw new VerificationPersistenceError('Failed to record the clearance verification', { cause });
    }
  }
}
