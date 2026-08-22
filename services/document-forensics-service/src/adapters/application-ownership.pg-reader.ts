// ══════════════════════════════════════════════════════════════════
// document-forensics-service — ApplicationOwnershipReader adapter (PostgreSQL)
//
// One read-only transaction as usrp_system_service, scanning the three ops
// schemas for the application. The applicant id is part of the PREDICATE, so a
// row belonging to another citizen is simply not found — the ownership check
// IS the lookup (the ADR-020 self-withdrawal idiom), not a comparison done
// afterwards in application code where it can be forgotten.
//
// NO `FOR UPDATE`, deliberately. Self-withdrawal locks because it transitions
// the row it read. This only reads, and an upload does not mutate the
// application — taking a row lock on every certificate upload would serialize
// unrelated uploads against officer transitions for no correctness gain.
//
// The loop stops at the FIRST match. An application id is a UUID and each ops
// schema is a disjoint population, so at most one schema can hold it; the
// remaining queries would be pure waste.
//
// status is selected ::text — the three application_status enums differ, so
// there is no single type to decode into. See the port header.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { AGENCIES } from '@usrp/shared-types';
import { SYSTEM_ROLE, schemaForAgency } from '../domain/agency-schema.js';
import { ForensicsPersistenceError } from '../domain/forensics.errors.js';
import type {
  ApplicationOwnershipReader,
  OwnedApplication,
  OwnershipQuery,
} from '../ports/application-ownership-reader.js';

export class PgApplicationOwnershipReader implements ApplicationOwnershipReader {
  async findOwnedApplication(query: OwnershipQuery): Promise<OwnedApplication | null> {
    try {
      return await sql.begin(async (tx): Promise<OwnedApplication | null> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        for (const agency of AGENCIES) {
          const schema = sql(schemaForAgency(agency));
          const rows = await tx<{ status: string }[]>`
            SELECT status::text AS status
            FROM ${schema}.applications
            WHERE id = ${query.applicationId}
              AND applicant_id = ${query.applicantId}
          `;
          const row = rows[0];
          if (row) return { agency, status: row.status };
        }
        return null;
      });
    } catch (cause) {
      throw new ForensicsPersistenceError('Failed to resolve application ownership', { cause });
    }
  }
}
