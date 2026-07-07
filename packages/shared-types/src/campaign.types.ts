// ══════════════════════════════════════════════════════════════════
// @usrp/shared-types — Recruitment Campaign Lifecycle
//
// A "campaign" is one active recruitment cycle for one agency.
// Example: "RDF-2026" is a campaign. "RCS-OFFICER-2026" is another.
// Multiple agencies can have simultaneous active campaigns.
// The system must know which campaign is active to:
//   1. Assign applicants to correct exam venues/dates
//   2. Lock registration windows correctly
//   3. Apply the right eligibility rules for that year
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationCategory, District } from './agency.types';

export type CampaignStatus =
  | 'DRAFT'               // Created by admin, not yet published
  | 'REGISTRATION_OPEN'   // Public can apply
  | 'REGISTRATION_CLOSED' // Window ended, vetting continues
  | 'EXAMINATION_ACTIVE'  // Exam days in progress
  | 'COMPLETED'           // All selections finalized
  | 'CANCELLED';          // Cancelled by authority

export interface RecruitmentCampaign {
  readonly id: string;
  readonly campaignLabel: string;              // e.g. "RDF-2026", "RCS-OFFICER-2026"
  readonly agency: Agency;
  readonly targetCategories: readonly ApplicationCategory[];
  readonly status: CampaignStatus;

  // Registration window
  readonly registrationOpensAt: string;        // ISO 8601
  readonly registrationClosesAt: string;

  // Examination window
  readonly examinationStartDate: string;
  readonly examinationEndDate: string;
  readonly examinationReportingHour: number;   // 8 = 8AM, 9 = 9AM

  // Walk-in policy for this campaign
  readonly allowsWalkIn: boolean;

  // Target intake numbers (for slot capacity management)
  readonly targetIntakeCount: number | null;

  // Contact information (from announcement)
  readonly contactPhoneNumbers: readonly string[];
  readonly contactWebsite: string | null;

  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Campaign Venue Assignment ─────────────────────────────────────
// Links a campaign to specific exam venues per district

export interface CampaignVenueAssignment {
  readonly id: string;
  readonly campaignId: string;
  readonly district: District;
  readonly venueName: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  readonly capacityLimit: number | null;    // null = unlimited
  readonly registeredCount: number;
  readonly isActive: boolean;
}

// ── Canonical Campaign Definitions from Official Announcements ────
// Used for seeding — not hardcoded in application logic

export const OFFICIAL_CAMPAIGNS = [
  {
    campaignLabel: 'RDF-2026',
    agency: 'RDF' as Agency,
    targetCategories: [
      'GENERAL_ENLISTMENT',
      'RESERVE_FORCE_ALEVEL',
      'RESERVE_FORCE_UNIVERSITY',
      'RESERVE_FORCE_SPECIALIST'
    ] as ApplicationCategory[],
    registrationOpensAt: '2026-05-23T08:00:00+02:00',
    registrationClosesAt: '2026-06-01T17:00:00+02:00',
    examinationStartDate: '2026-06-02',
    examinationEndDate: '2026-06-17',
    examinationReportingHour: 8,
    allowsWalkIn: true,
    contactWebsite: 'https://www.mod.gov.rw',
    contactPhoneNumbers: [],
  },
  {
    campaignLabel: 'RNP-CADET-2025',
    agency: 'RNP' as Agency,
    targetCategories: ['CADET_OFFICER'] as ApplicationCategory[],
    registrationOpensAt: '2025-05-07T08:00:00+02:00',
    registrationClosesAt: '2025-05-17T17:00:00+02:00',
    examinationStartDate: '2025-05-18',  // Not specified — TBD
    examinationEndDate: '2025-05-31',
    examinationReportingHour: 8,
    allowsWalkIn: false,
    contactWebsite: 'https://www.police.gov.rw',
    contactPhoneNumbers: ['0788311526', '0781860024', '0788311785'],
  },
  {
    campaignLabel: 'RNP-BASIC-2025',
    agency: 'RNP' as Agency,
    targetCategories: ['BASIC_POLICE_COURSE'] as ApplicationCategory[],
    registrationOpensAt: '2025-10-14T08:00:00+02:00',
    registrationClosesAt: '2025-11-07T17:00:00+02:00',
    examinationStartDate: '2025-11-08',  // Not specified — TBD
    examinationEndDate: '2025-11-30',
    examinationReportingHour: 8,
    allowsWalkIn: false,
    contactWebsite: 'https://www.police.gov.rw',
    contactPhoneNumbers: ['0788311526', '0788311785'],
  },
  {
    campaignLabel: 'RCS-GENERAL-2025',
    agency: 'RCS' as Agency,
    targetCategories: ['GENERAL_ENLISTEE'] as ApplicationCategory[],
    registrationOpensAt: '2025-08-09T08:00:00+02:00',
    registrationClosesAt: '2025-08-24T17:00:00+02:00',
    examinationStartDate: '2025-08-25',
    examinationEndDate: '2025-08-31',
    examinationReportingHour: 9,
    allowsWalkIn: false,
    contactWebsite: 'https://www.rcs.gov.rw',
    contactPhoneNumbers: ['0737627676', '0737626200', '0737626188'],
  },
  {
    campaignLabel: 'RCS-OFFICER-2026',
    agency: 'RCS' as Agency,
    targetCategories: [
      'OFFICER_ONE_YEAR',
      'OFFICER_ONE_YEAR_SPECIALIST',
      'OFFICER_FOUR_YEAR_UR'
    ] as ApplicationCategory[],
    registrationOpensAt: '2026-06-10T08:00:00+02:00',
    registrationClosesAt: '2026-06-29T17:00:00+02:00',
    examinationStartDate: '2026-06-30',
    examinationEndDate: '2026-07-02',
    examinationReportingHour: 9,
    allowsWalkIn: false,      // "Those who do not get to register will be able to 
                               // do so on the day of the exam" — 2026 announcement
                               // NOTE: RCS 2026 officer announcement DOES allow walk-in
                               // This is an exception — correcting:
    contactWebsite: 'https://www.rcs.gov.rw',
    contactPhoneNumbers: ['0737627676', '0737626200', '0737626188'],
  },
] as const;
