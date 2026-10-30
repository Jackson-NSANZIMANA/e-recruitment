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
  /**
   * ADR-049: per category, the rules a citizen may read before applying (age bands, accepted levels,
   * science bar), from the policy the campaign was published with. Detail reads only; empty for v1.
   */
  readonly eligibility?: Readonly<Record<string, PublicCategoryEligibility>>;
}

export interface PublicCategoryEligibility {
  readonly ageBands: readonly { readonly qualifications: readonly string[]; readonly minimumAge: number; readonly maximumAge: number }[];
  readonly educationAlternatives: readonly { readonly level: string }[];
  readonly minimumSciencePercent: number | null;
}

export interface CampaignPublicReadRepository {
  listOpen(): Promise<readonly PublicCampaign[]>;
  findPublishedByCode(publicCode: string): Promise<PublicCampaign | null>;
}
