// ══════════════════════════════════════════════════════════════════
// USRP — Campaign venue seeder
//
// Loads the district → venue map (ALL_EXAM_VENUES, from official
// announcements) into public_core.campaign_venue_assignments, resolving each
// venue's campaignLabel to the campaign it belongs to. One row per
// (campaign, district); idempotent via the (campaign_id, district) unique index.
//
// Deliberately NOT part of the structural DB bootstrap (like campaign authoring,
// this is admin/reference data, not schema). Call it from an admin seed runner
// once campaigns exist. Self-checks provision their own venue rows hermetically.
// ══════════════════════════════════════════════════════════════════

import type { Sql } from 'postgres';
import { ALL_EXAM_VENUES } from './exam-venues.seed.js';

export interface SeedVenuesResult {
  readonly inserted: number;
  readonly skippedNoCampaign: readonly string[]; // campaign labels not found
}

/**
 * Seed campaign_venue_assignments from ALL_EXAM_VENUES. Resolves campaignLabel →
 * campaign id via recruitment_campaigns; venues whose campaign is not yet
 * authored are skipped (reported), not an error. Uses examDateStart as the
 * reporting exam_date. Idempotent: re-running inserts nothing new.
 */
export async function seedCampaignVenues(sql: Sql): Promise<SeedVenuesResult> {
  // Resolve campaign labels once.
  const labels = [...new Set(ALL_EXAM_VENUES.map((v) => v.campaignLabel))];
  const campaigns = await sql<{ id: string; campaign_label: string }[]>`
    SELECT id, campaign_label FROM public_core.recruitment_campaigns
    WHERE campaign_label IN ${sql(labels)}
  `;
  const idByLabel = new Map(campaigns.map((c) => [c.campaign_label, c.id]));

  let inserted = 0;
  const skipped = new Set<string>();
  for (const v of ALL_EXAM_VENUES) {
    const campaignId = idByLabel.get(v.campaignLabel);
    if (campaignId === undefined) {
      skipped.add(v.campaignLabel);
      continue;
    }
    const rows = await sql`
      INSERT INTO public_core.campaign_venue_assignments
        (campaign_id, district, province, venue_name, exam_date, reporting_time_hour)
      VALUES (${campaignId}, ${v.district}, ${v.province}, ${v.venueName},
              ${v.examDateStart}, ${v.reportingTimeHour})
      ON CONFLICT (campaign_id, district) DO NOTHING
      RETURNING id
    `;
    inserted += rows.length;
  }

  return { inserted, skippedNoCampaign: [...skipped] };
}
