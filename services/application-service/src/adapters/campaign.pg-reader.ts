// ══════════════════════════════════════════════════════════════════
// application-service — CampaignReader adapter (PostgreSQL)
//
// Resolves the open campaign a submission attaches to, as
// usrp_system_service. A campaign qualifies iff it is REGISTRATION_OPEN,
// its registration window contains now(), it belongs to the category's
// agency, and its target_categories JSON array includes the category. The
// newest-opening qualifying campaign wins if more than one matches. A null
// result is a business rejection (NO_OPEN_CAMPAIGN), surfaced by the use
// case — not an error.
//
// target_categories is a TEXT column holding a JSON array (e.g.
// '["GENERAL_ENLISTMENT"]'); jsonb_exists over its ::jsonb cast tests
// membership without any driver-level operator ambiguity.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { Agency, ApplicationCategory } from '@usrp/shared-types';
import type { CampaignReader, OpenCampaign } from '../ports/campaign-reader.js';
import { ApplicationReadError } from '../domain/application.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';

export class PgCampaignReader implements CampaignReader {
  async findOpenCampaign(
    agency: Agency,
    category: ApplicationCategory,
  ): Promise<OpenCampaign | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<{ id: string; campaign_label: string }[]>`
          SELECT id, campaign_label
          FROM public_core.recruitment_campaigns
          WHERE agency = ${agency}::public_core.agency
            AND status = 'REGISTRATION_OPEN'
            AND registration_opens_at <= now()
            AND registration_closes_at > now()
            AND jsonb_exists(target_categories::jsonb, ${category})
          ORDER BY registration_opens_at DESC
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        return { campaignId: row.id, campaignLabel: row.campaign_label };
      });
    } catch (cause) {
      throw new ApplicationReadError('Failed to resolve an open campaign', { cause });
    }
  }

  async findWalkInCampaign(
    agency: Agency,
    category: ApplicationCategory,
  ): Promise<OpenCampaign | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        // Walk-in registration happens on EXAM DAY (ADR-012): the registration
        // window has closed, so the qualifying window is the examination one.
        // examination_*_date are ISO 'YYYY-MM-DD' varchars — lexical comparison
        // against current_date::text is exact for that format. The campaign
        // must explicitly allow walk-ins and be in an ACTIVE state (a campaign
        // still open for registration whose exam window has started counts).
        const rows = await tx<{ id: string; campaign_label: string }[]>`
          SELECT id, campaign_label
          FROM public_core.recruitment_campaigns
          WHERE agency = ${agency}::public_core.agency
            AND allows_walk_in = true
            AND status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EXAMINATION_ACTIVE')
            AND examination_start_date <= current_date::text
            AND examination_end_date >= current_date::text
            AND jsonb_exists(target_categories::jsonb, ${category})
          ORDER BY examination_start_date DESC
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        return { campaignId: row.id, campaignLabel: row.campaign_label };
      });
    } catch (cause) {
      throw new ApplicationReadError('Failed to resolve a walk-in campaign', { cause });
    }
  }
}
