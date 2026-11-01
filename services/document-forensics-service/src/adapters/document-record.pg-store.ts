// ══════════════════════════════════════════════════════════════════
// document-forensics-service — DocumentRecordStore adapter (PostgreSQL)
//
// First writer of the document_records tables (modeled since baseline, dead
// until now). One transaction as usrp_system_service into the OWNING agency
// schema: the application lookup is the cross-agency guard (document_records
// has no RLS — agency = schema, exactly like the applications projections).
// Idempotent re-analysis: one row per (application, object key) — a repeat
// analyze of the same object UPDATEs the verdict in place rather than
// growing duplicate rows.
//
// ── D8 (ADR-052): THE REVIEW LOCK, AND WHY IT LIVES IN THIS TRANSACTION ──
//
// Before this, a second upload of the same document type silently UPDATE'd the
// slot and left `human_reviewed_*` alone: a citizen could get a certificate
// reviewed CLEAR and then replace the bytes under the platform's own approval
// stamp. The rule now:
//
//   a replacement upload is accepted while BOTH hold —
//     • the application's status is at or below DOCUMENT_REVIEW_AMBER in the
//       CANONICAL APPLICATION_STATUSES order (the same ordering the lifecycle
//       uses; nothing hand-written here), and
//     • the slot has no human_reviewed_at.
//   otherwise → REVIEW_CLOSED, nothing written, the object NOT touched.
//
// The check is here, not in the use case, because it must be atomic with the
// revision bump: two concurrent uploads and an officer's approval see one
// serialised order under FOR UPDATE. The object write is invoked from inside
// this transaction (see the port) so a refusal cannot have already destroyed
// the reviewed bytes.
// ══════════════════════════════════════════════════════════════════

import { sql, asJsonb } from '@usrp/shared-database';
import type { Agency, ApplicationStatus } from '@usrp/shared-types';
import type {
  DocumentRecordStore,
  RecordVerdictInput,
  RecordVerdictOutcome,
} from '../ports/document-record-store.js';
import { ForensicsPersistenceError } from '../domain/forensics.errors.js';
import { decideSupersession } from '../domain/supersession.js';

const SYSTEM_ROLE = 'usrp_system_service';

const AGENCY_SCHEMA: Readonly<Record<Agency, 'rdf_ops' | 'rnp_ops' | 'rcs_ops'>> = {
  RDF: 'rdf_ops',
  RNP: 'rnp_ops',
  RCS: 'rcs_ops',
};

export class PgDocumentRecordStore implements DocumentRecordStore {
  async recordVerdict(input: RecordVerdictInput): Promise<RecordVerdictOutcome> {
    const schema = sql(AGENCY_SCHEMA[input.agency]);
    const { verdict } = input;
    try {
      return await sql.begin(async (tx): Promise<RecordVerdictOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        // Cross-agency guard: the application must exist in the CLAIMED
        // agency's schema. A mis-routed or fabricated id surfaces as NOT_FOUND.
        // The status comes back in the same read so the review gate needs no
        // second round trip.
        const apps = await tx<{ id: string; status: ApplicationStatus }[]>`
          SELECT id, status::text AS status FROM ${schema}.applications WHERE id = ${input.applicationId}
        `;
        const app = apps[0];
        if (app === undefined) return { kind: 'APPLICATION_NOT_FOUND' };

        // One row per (application, object key); FOR UPDATE so a concurrent
        // re-analysis of the same object serialises instead of racing.
        const existing = await tx<
          { id: string; revision: number; content_hmac: string | null; human_reviewed_at: Date | null }[]
        >`
          SELECT id, revision, content_hmac, human_reviewed_at
          FROM ${schema}.document_records
          WHERE application_id = ${input.applicationId}
            AND minio_object_key = ${input.objectKey}
          FOR UPDATE
        `;

        const slot = existing[0];

        // ── The decision is PURE (domain/supersession.ts) ──────────
        // The adapter has no branch of its own, so the review lock cannot drift
        // from the rule the proof exhausts. Everything below only executes it.
        const decision = decideSupersession(
          {
            caseStatus: app.status,
            humanReviewed: slot !== undefined && slot.human_reviewed_at !== null,
            storedHmac: slot?.content_hmac ?? null,
            exists: slot !== undefined,
          },
          input.contentHmac,
          slot?.revision ?? 1,
        );

        if (decision.kind === 'CLOSED_HUMAN_REVIEW') {
          // A HUMAN decision is absolute: the officer saw these bytes and
          // stamped them. Nothing written, and the object is NOT touched —
          // input.writeObject() is never called on any refusal path.
          return { kind: 'REVIEW_CLOSED', reason: 'HUMAN_REVIEWED' };
        }
        if (decision.kind === 'CLOSED_CASE_ADVANCED') {
          return { kind: 'REVIEW_CLOSED', reason: 'CASE_ADVANCED' };
        }

        if (decision.kind === 'RETRY' && slot !== undefined) {
          // Identical bytes: a retry, not a supersession. No object write (it
          // would be the same bytes) and no new revision.
          return { kind: 'RECORDED', documentId: slot.id, revision: decision.revision, superseded: false };
        }

        if (slot !== undefined && decision.kind === 'SUPERSEDE') {
          // Bytes CHANGE → the ledger row and the slot update are written in
          // this transaction, and the object is replaced inside it too.
          const revision = decision.revision;
          await input.writeObject();

          await tx`
            INSERT INTO ${schema}.document_revisions (
              document_id, application_id, revision, content_hmac, file_size_bytes,
              mime_type, forensics_lane, forensics_score, forensics_flags, uploaded_by
            ) VALUES (
              ${slot.id}, ${input.applicationId}, ${revision}, ${input.contentHmac},
              ${input.fileSizeBytes}, ${input.mimeType},
              ${verdict.lane}::${schema}.document_lane, ${String(verdict.score)}::numeric,
              ${tx.json(asJsonb(verdict.flags))}, 'APPLICANT'
            )
          `;

          await tx`
            UPDATE ${schema}.document_records SET
              document_type = ${input.documentType}::${schema}.document_type,
              minio_object_bucket = ${input.objectBucket},
              file_size_bytes = ${input.fileSizeBytes},
              mime_type = ${input.mimeType},
              virus_scan_status = ${input.virusScanStatus},
              virus_scan_at = now(),
              forensics_score = ${verdict.score},
              forensics_lane = ${verdict.lane}::${schema}.document_lane,
              forensics_flags = ${tx.json(asJsonb(verdict.flags))},
              forensics_completed_at = now(),
              revision = ${revision},
              content_hmac = ${input.contentHmac}
            WHERE id = ${slot.id}
          `;
          return { kind: 'RECORDED', documentId: slot.id, revision, superseded: true };
        }

        // ── A new slot (CREATE). The case-advancement gate has already been
        // applied by the decision function.
        await input.writeObject();

        const inserted = await tx<{ id: string }[]>`
          INSERT INTO ${schema}.document_records (
            application_id, document_type, minio_object_key, minio_object_bucket,
            file_size_bytes, mime_type, virus_scan_status, virus_scan_at,
            forensics_score, forensics_lane, forensics_flags, forensics_completed_at,
            revision, content_hmac
          ) VALUES (
            ${input.applicationId},
            ${input.documentType}::${schema}.document_type,
            ${input.objectKey},
            ${input.objectBucket},
            ${input.fileSizeBytes},
            ${input.mimeType},
            ${input.virusScanStatus},
            now(),
            ${verdict.score},
            ${verdict.lane}::${schema}.document_lane,
            ${tx.json(asJsonb(verdict.flags))},
            now(),
            1,
            ${input.contentHmac}
          )
          RETURNING id
        `;
        const row = inserted[0];
        if (!row) throw new ForensicsPersistenceError('INSERT returned no row');

        // Revision 1 is on the trail too: the trail must be a complete record of
        // what passed through the slot, not only of what replaced something.
        await tx`
          INSERT INTO ${schema}.document_revisions (
            document_id, application_id, revision, content_hmac, file_size_bytes,
            mime_type, forensics_lane, forensics_score, forensics_flags, uploaded_by
          ) VALUES (
            ${row.id}, ${input.applicationId}, 1, ${input.contentHmac},
            ${input.fileSizeBytes}, ${input.mimeType},
            ${verdict.lane}::${schema}.document_lane, ${String(verdict.score)}::numeric,
            ${tx.json(asJsonb(verdict.flags))}, 'APPLICANT'
          )
        `;

        return { kind: 'RECORDED', documentId: row.id, revision: 1, superseded: false };
      });
    } catch (cause) {
      throw cause instanceof ForensicsPersistenceError
        ? cause
        : new ForensicsPersistenceError('Failed to record forensics verdict', { cause });
    }
  }
}
