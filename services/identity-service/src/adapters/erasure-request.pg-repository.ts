// ══════════════════════════════════════════════════════════════════
// identity-service — ErasureRequestRepository adapter (PostgreSQL)
//
// Every method runs as usrp_system_service (rls/0017: system-scoped
// store, same posture as the OTP store and the erasure road itself).
// Filing locks the applicant's live request row if one exists — two
// concurrent files of the same citizen serialize on it, and the partial
// unique index (one PENDING per applicant) backstops the race where
// both saw nothing: the loser's INSERT errors instead of duplicating.
// Timestamps are bound as ISO strings (postgres.js Date-binding fails
// inside SET LOCAL ROLE transactions) — here now() suffices everywhere.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { IdentityPersistenceError } from '../domain/identity.errors.js';
import type {
  DeclineRequestInput,
  DeclineRequestOutcome,
  ErasureRequestRecord,
  ErasureRequestRepository,
  FileRequestOutcome,
} from '../ports/erasure-request.repository.js';

const SYSTEM_ROLE = 'usrp_system_service';
const ENCRYPTION_KEY_SETTING = 'app.encryption_key';

interface RequestRow {
  readonly id: string;
  readonly applicant_id: string;
  readonly status: 'PENDING' | 'EXECUTED' | 'DECLINED';
  readonly requested_at: string | Date;
  readonly decided_at: string | Date | null;
  readonly decision_note: string | null;
}

export class PgErasureRequestRepository implements ErasureRequestRepository {
  /**
   * @param encryptionKey pgcrypto key — provide it so decline can resolve
   *   the stored contact for the decision notice (ADR-022); omit where no
   *   notice is sent (the erasure road's markExecuted-only wiring).
   */
  constructor(private readonly encryptionKey?: string) {}

  async fileRequest(applicantId: string): Promise<FileRequestOutcome> {
    try {
      return await sql.begin(async (tx): Promise<FileRequestOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const pending = await tx<{ id: string }[]>`
          SELECT id FROM public_core.erasure_requests
          WHERE applicant_id = ${applicantId} AND status = 'PENDING'
          FOR UPDATE
        `;
        const existing = pending[0];
        if (existing) {
          return { kind: 'ALREADY_PENDING', requestId: existing.id };
        }
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO public_core.erasure_requests (applicant_id)
          VALUES (${applicantId})
          RETURNING id
        `;
        const row = inserted[0];
        if (!row) throw new Error('INSERT returned no row');
        return { kind: 'FILED', requestId: row.id };
      });
    } catch (cause) {
      throw new IdentityPersistenceError('Failed to file erasure request', { cause });
    }
  }

  async latestForApplicant(applicantId: string): Promise<ErasureRequestRecord | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<RequestRow[]>`
          SELECT id, applicant_id, status, requested_at, decided_at, decision_note
          FROM public_core.erasure_requests
          WHERE applicant_id = ${applicantId}
          ORDER BY requested_at DESC
          LIMIT 1
        `;
        return rows[0] ? toRecord(rows[0]) : null;
      });
    } catch (cause) {
      throw new IdentityPersistenceError('Failed to read erasure request', { cause });
    }
  }

  async listPending(): Promise<readonly ErasureRequestRecord[]> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<RequestRow[]>`
          SELECT id, applicant_id, status, requested_at, decided_at, decision_note
          FROM public_core.erasure_requests
          WHERE status = 'PENDING'
          ORDER BY requested_at ASC
        `;
        return rows.map(toRecord);
      });
    } catch (cause) {
      throw new IdentityPersistenceError('Failed to list erasure requests', { cause });
    }
  }

  async decline(input: DeclineRequestInput): Promise<DeclineRequestOutcome> {
    try {
      return await sql.begin(async (tx): Promise<DeclineRequestOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ applicant_id: string; status: RequestRow['status'] }[]>`
          SELECT applicant_id, status FROM public_core.erasure_requests
          WHERE id = ${input.requestId}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) return { kind: 'NOT_FOUND' };
        if (row.status !== 'PENDING') return { kind: 'NOT_PENDING', status: row.status };
        await tx`
          UPDATE public_core.erasure_requests SET
            status = 'DECLINED',
            decided_by = ${input.officerId},
            decided_at = now(),
            decision_note = ${input.note}
          WHERE id = ${input.requestId}
        `;

        // Resolve the stored contact for the decision notice (ADR-022) in
        // the SAME transaction — memory-only, the caller sends after commit.
        let noticeContact: string | null = null;
        if (this.encryptionKey !== undefined) {
          await tx`SELECT set_config(${ENCRYPTION_KEY_SETTING}, ${this.encryptionKey}, true)`;
          const contact = await tx<{ phone: string | null }[]>`
            SELECT CASE WHEN encrypted_phone_number IS NULL THEN NULL
                        ELSE pgp_sym_decrypt(encrypted_phone_number::bytea, current_setting(${ENCRYPTION_KEY_SETTING}))
                   END AS phone
            FROM public_core.applicant_identities
            WHERE id = ${row.applicant_id} AND deleted_at IS NULL
          `;
          noticeContact = contact[0]?.phone ?? null;
        }

        return { kind: 'DECLINED', applicantId: row.applicant_id, noticeContact };
      });
    } catch (cause) {
      throw new IdentityPersistenceError('Failed to decline erasure request', { cause });
    }
  }

  async markExecuted(applicantId: string, officerId: string): Promise<number> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ id: string }[]>`
          UPDATE public_core.erasure_requests SET
            status = 'EXECUTED',
            decided_by = ${officerId},
            decided_at = now()
          WHERE applicant_id = ${applicantId} AND status = 'PENDING'
          RETURNING id
        `;
        return rows.length;
      });
    } catch (cause) {
      throw new IdentityPersistenceError('Failed to mark erasure request executed', { cause });
    }
  }
}

function toRecord(row: RequestRow): ErasureRequestRecord {
  return {
    requestId: row.id,
    applicantId: row.applicant_id,
    status: row.status,
    requestedAt: iso(row.requested_at),
    decidedAt: row.decided_at === null ? null : iso(row.decided_at),
    decisionNote: row.decision_note,
  };
}

/** shared sql surfaces timestamptz as string in some paths — total over both. */
function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
