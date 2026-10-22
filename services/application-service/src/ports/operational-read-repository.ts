// ══════════════════════════════════════════════════════════════════
// application-service — OperationalReadRepository port (ADR-039)
//
// The officer console's operational reads. Every method runs under the
// officer's OWN agency DB role (a dumb executor: the caller resolves the role
// from the verified principal). Nothing here carries a name, a National ID, a
// phone number or an internal campaign UUID.
// ══════════════════════════════════════════════════════════════════

import type { DbRole } from '@usrp/shared-auth';
import type { Agency, ApplicationStatus, CampaignStatus, DocumentType } from '@usrp/shared-types';
import type { ApplicationSearch, CampaignAdminSearch, RosterAdmissionState, RosterQuery } from '../domain/operational-reads.js';

export interface AgencyScope {
  readonly agency: Agency;
  readonly dbRole: DbRole;
}

// ── applications v2 ──
export interface ApplicationSearchRow {
  readonly applicationId: string;
  readonly processingCode: string;
  readonly category: string;
  readonly status: ApplicationStatus;
  readonly submittedAt: string | null;
  /** Keyset position of this row (microsecond UTC string). */
  readonly sortKey: string;
}

export interface ApplicationSearchPage {
  readonly rows: readonly ApplicationSearchRow[];
  /** Rows matching the filters, ignoring the cursor. */
  readonly total: number;
  readonly hasMore: boolean;
}

// ── campaigns ──
export interface CampaignOccupancy {
  readonly sessionCount: number;
  /** Sum of bounded capacities; null when no session has a bounded capacity. */
  readonly capacityTotal: number | null;
  readonly hasUnboundedSession: boolean;
  readonly registeredTotal: number;
}

export interface CampaignAdminSummary {
  readonly publicCode: string;
  readonly campaignLabel: string;
  readonly status: CampaignStatus;
  readonly targetCategories: readonly string[];
  readonly targetDistricts: readonly string[];
  readonly registrationOpensAt: string;
  readonly registrationClosesAt: string;
  readonly examinationStartDate: string;
  readonly examinationEndDate: string;
  readonly allowsWalkIn: boolean;
  readonly targetIntakeCount: number | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly occupancy: CampaignOccupancy;
}

/** A listed campaign with its keyset position (the internal id never leaves the service). */
export interface CampaignAdminRow {
  readonly summary: CampaignAdminSummary;
  readonly sortKey: string;
  readonly cursorId: string;
}

export interface CampaignAdminPage {
  readonly rows: readonly CampaignAdminRow[];
  readonly total: number;
  readonly hasMore: boolean;
}

export interface CampaignSessionOccupancy {
  readonly district: string;
  readonly province: string;
  readonly venueName: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  /** null = unbounded by an explicit owner decision (capacityDecisionCode). */
  readonly capacityLimit: number | null;
  readonly capacityDecisionCode: string | null;
  readonly registeredCount: number;
  readonly remaining: number | null;
  readonly isActive: boolean;
}

export interface CampaignAdminDetail {
  readonly summary: CampaignAdminSummary;
  readonly contactPhoneNumbers: readonly string[] | null;
  readonly contactWebsite: string | null;
  readonly announcementReference: string | null;
  readonly registrationClosedAt: string | null;
  readonly cancelledAt: string | null;
  readonly policy: {
    readonly versionNumber: number;
    readonly policyHash: string;
    readonly hashVersion: number;
    readonly legalBasisCode: string;
    readonly createdAt: string;
  } | null;
  readonly coverage: { readonly version: number; readonly hash: string } | null;
  readonly sessions: readonly CampaignSessionOccupancy[];
  readonly history: readonly {
    readonly fromStatus: CampaignStatus | null;
    readonly toStatus: CampaignStatus;
    readonly reasonCode: string | null;
    readonly occurredAt: string;
  }[];
}

// ── roster ──
export interface RosterEntry {
  readonly processingCode: string;
  readonly category: string;
  readonly status: ApplicationStatus;
  readonly admission: RosterAdmissionState;
  /** Documents the candidate is asked to present (advisory, ADR-032). */
  readonly requiredPaperItems: readonly DocumentType[];
}

export interface VenueRoster {
  readonly venueName: string;
  readonly district: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  readonly capacityLimit: number | null;
  readonly registeredCount: number;
  readonly entries: readonly RosterEntry[];
  readonly truncated: boolean;
}

// ── venue live counts (S09, rls/0036) ──
export interface VenueLiveCounts {
  readonly venueName: string;
  readonly district: string;
  readonly examDate: string;
  readonly expected: number;
  readonly admitted: number;
  readonly physicalCaptured: number;
  readonly medicalRecorded: number;
  readonly openConflicts: number;
  /** When the projection row was last recomputed; null = no event has touched this venue day yet. */
  readonly asOf: string | null;
}

export interface OperationalReadRepository {
  searchApplications(scope: AgencyScope, search: ApplicationSearch): Promise<ApplicationSearchPage>;
  listCampaigns(scope: AgencyScope, search: CampaignAdminSearch): Promise<CampaignAdminPage>;
  /** null = no such campaign in the caller's agency (indistinguishable from a sibling's). */
  findCampaignDetail(scope: AgencyScope, publicCode: string): Promise<CampaignAdminDetail | null>;
  /** null = no such campaign or no such venue day in the caller's agency. */
  venueRoster(scope: AgencyScope, query: RosterQuery): Promise<VenueRoster | null>;
  /** null = no such campaign or venue day in the caller's agency. Reads the event-driven projection. */
  venueLiveCounts(scope: AgencyScope, query: RosterQuery): Promise<VenueLiveCounts | null>;
}
