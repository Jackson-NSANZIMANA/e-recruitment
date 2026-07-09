// ══════════════════════════════════════════════════════════════════
// scheduling-service — VenueReader adapter (PostgreSQL)
//
// Resolves the exam venue a district reports to for a campaign from
// public_core.campaign_venue_assignments (the district → venue map seeded from
// official announcements), read as usrp_system_service. Non-PII reference data,
// no RLS — the 0008 grant covers it. Only active venues are considered.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { VenueAssignment, VenueReader } from '../ports/readers.js';
import { SchedulingReadError } from '../domain/scheduling.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';

interface VenueRow {
  readonly id: string;
  readonly district: string;
  readonly venue_name: string;
  readonly exam_date: string;
  readonly reporting_time_hour: number;
}

export class PgVenueReader implements VenueReader {
  async venueFor(campaignId: string, district: string): Promise<VenueAssignment | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<VenueRow[]>`
          SELECT id, district, venue_name, exam_date, reporting_time_hour
          FROM public_core.campaign_venue_assignments
          WHERE campaign_id = ${campaignId}
            AND district = ${district}
            AND is_active = true
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        return {
          venueAssignmentId: row.id,
          district: row.district,
          venueName: row.venue_name,
          examDate: row.exam_date,
          reportingTimeHour: row.reporting_time_hour,
        };
      });
    } catch (cause) {
      throw new SchedulingReadError('Failed to read venue assignment', { cause });
    }
  }
}
