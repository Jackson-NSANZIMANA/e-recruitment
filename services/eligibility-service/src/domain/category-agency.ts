// ══════════════════════════════════════════════════════════════════
// eligibility-service — Category ↔ agency mapping
//
// The 10 application categories each belong to exactly one agency. This
// map is derived from the ground-truth category lists so it can never
// drift from them, and backs both input validation (is this a real
// category?) and the audit event's agency attribution.
// ══════════════════════════════════════════════════════════════════

import {
  RDF_APPLICATION_CATEGORIES,
  RNP_APPLICATION_CATEGORIES,
  RCS_APPLICATION_CATEGORIES,
  type Agency,
  type ApplicationCategory,
} from '@usrp/shared-types';

const ENTRIES: ReadonlyArray<readonly [ApplicationCategory, Agency]> = [
  ...RDF_APPLICATION_CATEGORIES.map((c) => [c, 'RDF'] as const),
  ...RNP_APPLICATION_CATEGORIES.map((c) => [c, 'RNP'] as const),
  ...RCS_APPLICATION_CATEGORIES.map((c) => [c, 'RCS'] as const),
];

export const CATEGORY_TO_AGENCY: ReadonlyMap<string, Agency> = new Map(ENTRIES);

/** All valid application categories, for O(1) input validation. */
export const ALL_CATEGORIES: ReadonlySet<string> = new Set(ENTRIES.map(([category]) => category));

/** The agency that owns a category. Throws on an unknown category (guard upstream). */
export function agencyForCategory(category: ApplicationCategory): Agency {
  const agency = CATEGORY_TO_AGENCY.get(category);
  if (agency === undefined) {
    throw new Error(`No agency mapping for application category "${category}"`);
  }
  return agency;
}
