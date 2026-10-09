import { sql } from '@usrp/shared-database';
import type {
  Agency,
  ApplicationCategory,
  CampaignStatus,
  District,
} from '@usrp/shared-types';
import type {
  CampaignPublicReadRepository,
  PublicCampaign,
} from '../ports/campaign-public-read.repository.js';
import { CampaignReadError } from '../domain/campaign-control.errors.js';

const PUBLIC_READER_ROLE = 'usrp_campaign_public_reader';

interface PublicCampaignRow {
  readonly public_code: string;
  readonly campaign_label: string;
  readonly agency: string;
  readonly status: string;
  readonly registration_opens_at: Date | string;
  readonly registration_closes_at: Date | string;
  readonly examination_start_date: string;
  readonly examination_end_date: string;
  readonly target_categories: string;
  readonly target_districts: unknown;
  readonly allows_walk_in: boolean;
  readonly contact_phone_numbers: string | null;
  readonly contact_website: string | null;
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (cause) {
      throw new CampaignReadError(`Published campaign ${field} is not valid JSON.`, { cause });
    }
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new CampaignReadError(`Published campaign ${field} is not a string array.`);
  }
  return parsed as string[];
}

function timestamp(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new CampaignReadError(`Published campaign ${field} is invalid.`);
  return date.toISOString();
}

function project(row: PublicCampaignRow): PublicCampaign {
  const contactPhoneNumbers = row.contact_phone_numbers === null
    ? null
    : parseStringArray(row.contact_phone_numbers, 'contact_phone_numbers');
  const districts = parseStringArray(row.target_districts, 'target_districts');
  return {
    publicCode: row.public_code,
    campaignLabel: row.campaign_label,
    agency: row.agency as Agency,
    status: row.status as CampaignStatus,
    registrationOpensAt: timestamp(row.registration_opens_at, 'registration_opens_at'),
    registrationClosesAt: timestamp(row.registration_closes_at, 'registration_closes_at'),
    examinationStartDate: row.examination_start_date,
    examinationEndDate: row.examination_end_date,
    targetCategories: parseStringArray(row.target_categories, 'target_categories') as ApplicationCategory[],
    targetDistricts: districts as District[],
    allowsWalkIn: row.allows_walk_in,
    contactPhoneNumbers,
    contactWebsite: row.contact_website,
  };
}

export class PgCampaignPublicReadRepository implements CampaignPublicReadRepository {
  async listOpen(): Promise<readonly PublicCampaign[]> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(PUBLIC_READER_ROLE)}`;
        const rows = await tx<PublicCampaignRow[]>`
          SELECT public_code, campaign_label, agency, status,
                 registration_opens_at, registration_closes_at,
                 examination_start_date, examination_end_date,
                 target_categories, target_districts, allows_walk_in,
                 contact_phone_numbers, contact_website
          FROM public_core.campaign_public_read
          WHERE status = 'REGISTRATION_OPEN'
          ORDER BY registration_opens_at DESC, public_code ASC
        `;
        return rows.map(project);
      });
    } catch (cause) {
      if (cause instanceof CampaignReadError) throw cause;
      throw new CampaignReadError('Could not read published campaigns.', { cause });
    }
  }

  async findPublishedByCode(publicCode: string): Promise<PublicCampaign | null> {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(PUBLIC_READER_ROLE)}`;
        const rows = await tx<PublicCampaignRow[]>`
          SELECT public_code, campaign_label, agency, status,
                 registration_opens_at, registration_closes_at,
                 examination_start_date, examination_end_date,
                 target_categories, target_districts, allows_walk_in,
                 contact_phone_numbers, contact_website
          FROM public_core.campaign_public_read
          WHERE public_code = ${publicCode}
          LIMIT 1
        `;
        const row = rows[0];
        return row === undefined ? null : project(row);
      });
    } catch (cause) {
      if (cause instanceof CampaignReadError) throw cause;
      throw new CampaignReadError('Could not read the published campaign.', { cause });
    }
  }
}
