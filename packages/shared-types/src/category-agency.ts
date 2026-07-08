// ══════════════════════════════════════════════════════════════════
// @usrp/shared-types — Category ↔ agency mapping
//
// The 10 application categories each belong to exactly one agency. This
// map is derived from the ground-truth category lists in agency.types so
// it can never drift from them. It backs input validation (is this a real
// category?), agency attribution for events/audit, and — for the front
// door — routing a submission to the owning agency's isolated ops schema.
//
// This lives in shared-types (not any single service) because it is pure
// derivation from constants that already live here, with zero
// dependencies — the platform-wide source of truth for the mapping.
// ══════════════════════════════════════════════════════════════════

import {
  RDF_APPLICATION_CATEGORIES,
  RNP_APPLICATION_CATEGORIES,
  RCS_APPLICATION_CATEGORIES,
  type Agency,
  type ApplicationCategory,
} from './agency.types';

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
