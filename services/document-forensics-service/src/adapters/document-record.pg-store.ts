// ══════════════════════════════════════════════════════════════════
// document-forensics-service — DocumentRecordStore adapter (PostgreSQL)
//
// First writer of the document_records tables (modeled since baseline, dead
// until the forensics slice). One transaction as usrp_system_service into the
// OWNING agency schema: the application lookup is the cross-agency guard
// (document_records has no RLS — agency = schema, exactly like the
// applications projections). The agency→schema mapping is imported from
// domain/agency-schema.ts rather than declared here: it is a security control,
// and one copy means one place to get a fourth agency right.
//
// Idempotent by (application, object key): a repeat verdict on the same object
// UPDATEs in place instead of growing duplicate rows. That is what makes the
// upload ingress's DERIVED, STABLE object key safe — re-uploading a corrected
// certificate overwrites the object and refreshes this row, rather than
// leaving an un-analyzed orphan behind (see domain/object-key.ts).
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { SYSTEM_ROLE, schemaForAgency } from '../domain/agency-schema.js';
import type {
  DocumentRecordStore,
  RecordVerdictInput,
  RecordVerdictOutcome,
} from '../ports/document-record-store.js';
import { ForensicsPersistenceError } from '../domain/forensics.errors.js';

export class PgDocumentRecordStore implements DocumentRecordStore {
  async recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictOutcome> {
    const schema = sql(schemaForAgency(input.agency));
    const { verdict } = input;
    try {
      return await sql.begin(async (tx): Promise<RecordVerdictOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        // Cross-agency guard: the application must exist in the CLAIMED
        // agency's schema. A mis-routed or fabricated id surfaces as NOT_FOUND.
        const apps = await tx<{ id: string }[]>`
          SELECT id FROM ${schema}.applications WHERE id = ${input.applicationId}
        `;
        if (apps.length === 0) return { kind: 'APPLICATION_NOT_FOUND' };

        // One row per (application, object key); FOR UPDATE so a concurrent
        // re-analysis of the same object serializes instead of racing.
        const existing = await tx<{ id: string }[]>`
          SELECT id FROM ${schema}.document_records
          WHERE application_id = ${input.applicationId}
            AND minio_object_key = ${input.objectKey}
          FOR UPDATE
        `;

        const flagsJson = `${JSON.stringify(verdict.flags)}`;
        const existingRow = existing[0];
        if (existingRow) {
          await tx`
            UPDATE ${schema}.document_records SET
              document_type = ${input.documentType}::${schema}.document_type,
              minio_object_bucket = ${input.objectBucket},
              file_size_bytes = ${input.fileSizeBytes},
              virus_scan_status = ${input.virusScanStatus},
              virus_scan_at = now(),
              forensics_score = ${verdict.score},
              forensics_lane = ${verdict.lane}::${schema}.document_lane,
              forensics_flags = ${flagsJson}::jsonb,
              forensics_completed_at = now()
            WHERE id = ${existingRow.id}
          `;
          return { kind: 'RECORDED', documentId: existingRow.id };
        }

        const inserted = await tx<{ id: string }[]>`
          INSERT INTO ${schema}.document_records (
            application_id, document_type, minio_object_key, minio_object_bucket,
            file_size_bytes, virus_scan_status, virus_scan_at,
            forensics_score, forensics_lane, forensics_flags, forensics_completed_at
          ) VALUES (
            ${input.applicationId},
            ${input.documentType}::${schema}.document_type,
            ${input.objectKey},
            ${input.objectBucket},
            ${input.fileSizeBytes},
            ${input.virusScanStatus},
            now(),
            ${verdict.score},
            ${verdict.lane}::${schema}.document_lane,
            ${flagsJson}::jsonb,
            now()
          )
          RETURNING id
        `;
        const row = inserted[0];
        if (!row) throw new ForensicsPersistenceError('INSERT returned no row');
        return { kind: 'RECORDED', documentId: row.id };
      });
    } catch (cause) {
      throw cause instanceof ForensicsPersistenceError
        ? cause
        : new ForensicsPersistenceError('Failed to record forensics verdict', { cause });
    }
  }
}
