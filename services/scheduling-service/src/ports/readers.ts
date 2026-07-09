// ══════════════════════════════════════════════════════════════════
// scheduling-service — Reader ports
//
// Two reads compose a slot assignment: the applicant's home district (decrypted
// PII on the shared identity) and the venue that district maps to for the
// campaign. Both are abstracted so the use case is pure and testable; the
// PostgreSQL adapters implement them as usrp_system_service.
// ══════════════════════════════════════════════════════════════════

/** The applicant's home district, decrypted from the shared identity. */
export interface HomeDistrictReader {
  /** Returns the uppercase district code (e.g. 'GASABO'), or null if unknown/deleted. */
  homeDistrictOf(applicantId: string): Promise<string | null>;
}

/** A venue resolved for a (campaign, district) pair. */
export interface VenueAssignment {
  readonly venueAssignmentId: string;
  readonly district: string;
  readonly venueName: string;
  readonly examDate: string; // YYYY-MM-DD
  readonly reportingTimeHour: number;
}

/** Resolves the exam venue a district reports to, for a given campaign. */
export interface VenueReader {
  /** Returns the venue for (campaignId, district), or null if none is seeded. */
  venueFor(campaignId: string, district: string): Promise<VenueAssignment | null>;
}
