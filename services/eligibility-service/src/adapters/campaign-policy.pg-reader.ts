// eligibility-service — pinned campaign policy reader (PostgreSQL, as usrp_system_service; SELECT granted by rls/0030).
import { sql } from '@usrp/shared-database';
import { readPolicyV2 } from '@usrp/shared-campaign-policy';
import { CATEGORY_TO_AGENCY, type ApplicationCategory } from '@usrp/shared-types';
import type { CampaignPolicyReader } from '../ports/campaign-policy.reader.js';
import type { PinnedPolicy } from '../domain/policy-v2-gates.js';
import { EligibilityReadError } from '../domain/eligibility.errors.js';

const SCHEMA = { RDF: 'rdf_ops', RNP: 'rnp_ops', RCS: 'rcs_ops' } as const;

export class PgCampaignPolicyReader implements CampaignPolicyReader {
  async findPinnedPolicy(applicationId: string, category: ApplicationCategory): Promise<PinnedPolicy | null> {
    const agency = CATEGORY_TO_AGENCY.get(category);
    if (agency === undefined) return null;
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_system_service`;
        const rows = await tx<{ block: unknown; reference_date: string | null }[]>`
          SELECT pv.policy_document -> ${category} -> 'v2' AS block,
                 pv.policy_document -> ${category} -> 'age' ->> 'referenceDate' AS reference_date
          FROM ${sql(SCHEMA[agency])}.applications a
          JOIN public_core.campaign_policy_versions pv ON pv.id = a.policy_version_id
          WHERE a.id = ${applicationId}
          LIMIT 1
        `;
        const row = rows[0];
        // No application, or a v1 category (no v2 block): the engine constants govern, as before.
        if (row === undefined || row.block === null) return null;
        // A v2 block that cannot be read is a FAULT, not a v1 policy: judging the applicant by constants the
        // campaign did not print would be wrong in silence. The event is retried.
        const v2 = readPolicyV2(row.block);
        if (v2 === null || row.reference_date === null) throw new Error('the pinned v2 policy is unreadable');
        return { v2, referenceDate: row.reference_date };
      });
    } catch (cause) {
      throw new EligibilityReadError('Failed to read the pinned campaign policy', { cause });
    }
  }
}
