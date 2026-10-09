import type {
  Agency,
  ApplicationCategory,
  CampaignStatus,
  District,
} from '@usrp/shared-types';

/** Public allowlist projection; it has no database UUID or policy/session data. */
export interface PublicCampaign {
  readonly publicCode: string;
  readonly campaignLabel: string;
  readonly agency: Agency;
  readonly status: CampaignStatus;
  readonly registrationOpensAt: string;
  readonly registrationClosesAt: string;
  readonly examinationStartDate: string;
  readonly examinationEndDate: string;
  readonly targetCategories: readonly ApplicationCategory[];
  readonly targetDistricts: readonly District[];
  readonly allowsWalkIn: boolean;
  readonly contactPhoneNumbers: readonly string[] | null;
  readonly contactWebsite: string | null;
}

export interface CampaignPublicReadRepository {
  listOpen(): Promise<readonly PublicCampaign[]>;
  findPublishedByCode(publicCode: string): Promise<PublicCampaign | null>;
}
