// ══════════════════════════════════════════════════════════════════
// identity-service — RetentionRepository adapter (PostgreSQL)
//
// Runs as usrp_system_service — the only role that can see the identity
// table AND all three ops schemas (the negative-terminal class is a
// cross-agency judgment by definition). Status comparisons run on
// ::text (the rnp/rcs enums lack the WALK_IN_* values). Discovery is
// read-only; the purges are single-statement hard deletes.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { IdentityPersistenceError } from '../domain/identity.errors.js';
import type { RetentionRepository } from '../ports/retention-repository.js';

const SYSTEM_ROLE = 'usrp_system_service';

/** Terminal-negative statuses (ACCEPTED is deliberately NOT here — an
 * enlisted citizen's record is retained; erasure would be refused anyway). */
const NEGATIVE_TERMINAL: readonly string[] = ['REJECTED', 'WITHDRAWN', 'WALK_IN_REJECTED'];

export class PgRetentionRepository implements RetentionRepository {
  async findNeverApplied(cutoff: Date): Promise<readonly string[]> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ id: string }[]>`
          SELECT i.id FROM public_core.applicant_identities i
          WHERE i.deleted_at IS NULL
            AND i.created_at < ${cutoff.toISOString()}
            AND NOT EXISTS (SELECT 1 FROM rdf_ops.applications a WHERE a.applicant_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM rnp_ops.applications a WHERE a.applicant_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM rcs_ops.applications a WHERE a.applicant_id = i.id)
          ORDER BY i.created_at
        `;
        return rows.map((r) => r.id);
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to discover never-applied identities');
    }
  }

  async findNegativeTerminal(cutoff: Date): Promise<readonly string[]> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        // Every application negative-terminal AND none touched since the
        // cutoff. "No app outside the negative set" excludes ACCEPTED and
        // everything in flight; "no app updated since cutoff" is the
        // 24-month clock, measured on the rows' own updated_at.
        // (= ANY / <> ALL with a value array — postgres.js's IN-helper
        // mis-renders inside parenthesized subqueries.)
        const negatives = NEGATIVE_TERMINAL as string[];
        const rows = await tx<{ id: string }[]>`
          SELECT i.id FROM public_core.applicant_identities i
          WHERE i.deleted_at IS NULL
            AND (
              EXISTS (SELECT 1 FROM rdf_ops.applications a WHERE a.applicant_id = i.id) OR
              EXISTS (SELECT 1 FROM rnp_ops.applications a WHERE a.applicant_id = i.id) OR
              EXISTS (SELECT 1 FROM rcs_ops.applications a WHERE a.applicant_id = i.id)
            )
            AND NOT EXISTS (
              SELECT 1 FROM rdf_ops.applications a WHERE a.applicant_id = i.id
                AND (a.status::text <> ALL(${negatives}) OR a.updated_at >= ${cutoff.toISOString()}))
            AND NOT EXISTS (
              SELECT 1 FROM rnp_ops.applications a WHERE a.applicant_id = i.id
                AND (a.status::text <> ALL(${negatives}) OR a.updated_at >= ${cutoff.toISOString()}))
            AND NOT EXISTS (
              SELECT 1 FROM rcs_ops.applications a WHERE a.applicant_id = i.id
                AND (a.status::text <> ALL(${negatives}) OR a.updated_at >= ${cutoff.toISOString()}))
          ORDER BY i.created_at
        `;
        return rows.map((r) => r.id);
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to discover negative-terminal identities');
    }
  }

  async countPurgeableSessions(cutoff: Date): Promise<number> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM public_core.applicant_sessions
          WHERE coalesce(terminated_at, expires_at) < ${cutoff.toISOString()}`;
        return Number(rows[0]?.n ?? '0');
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to count purgeable sessions');
    }
  }

  async countPurgeableChallenges(cutoff: Date): Promise<number> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM public_core.applicant_otp_challenges
          WHERE coalesce(consumed_at, expires_at) < ${cutoff.toISOString()}`;
        return Number(rows[0]?.n ?? '0');
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to count purgeable OTP challenges');
    }
  }

  async purgeSessions(cutoff: Date): Promise<number> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const res = await tx`
          DELETE FROM public_core.applicant_sessions
          WHERE coalesce(terminated_at, expires_at) < ${cutoff.toISOString()}`;
        return res.count;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to purge sessions');
    }
  }

  async purgeChallenges(cutoff: Date): Promise<number> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const res = await tx`
          DELETE FROM public_core.applicant_otp_challenges
          WHERE coalesce(consumed_at, expires_at) < ${cutoff.toISOString()}`;
        return res.count;
      });
    } catch (cause) {
      throw wrap(cause, 'Failed to purge OTP challenges');
    }
  }
}

function wrap(cause: unknown, message: string): IdentityPersistenceError {
  return cause instanceof IdentityPersistenceError
    ? cause
    : new IdentityPersistenceError(message, { cause });
}
