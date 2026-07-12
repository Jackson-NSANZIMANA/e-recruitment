// ══════════════════════════════════════════════════════════════════
// field-sync-service — Agency → ops schema (pure)
//
// Each agency owns an isolated Postgres schema; physical_test_scores and
// applications live in that schema. Only three agencies exist, each mapped to a
// fixed, hard-coded schema name — no user input ever reaches an identifier.
// Kept local (a two-line map) rather than importing application-service, so the
// field-sync runtime carries no cross-service dependency.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

export const OPS_SCHEMA: Readonly<Record<Agency, string>> = {
  RDF: 'rdf_ops',
  RNP: 'rnp_ops',
  RCS: 'rcs_ops',
} as const;
