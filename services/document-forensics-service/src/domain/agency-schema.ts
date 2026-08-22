// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Agency → ops schema (the isolation boundary)
//
// ONE map, deliberately. In this system agency IS schema: cross-agency
// isolation for the ops tables is enforced by which schema a query names, so
// this mapping is a security control, not a lookup convenience. Two copies of
// it — one in the verdict store, one in the ownership reader — would be two
// places for a future agency to be added correctly in one and wrongly in the
// other. Same reasoning that made agency-bff one codebase and three
// deployments rather than three codebases.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

export type OpsSchema = 'rdf_ops' | 'rnp_ops' | 'rcs_ops';

export const AGENCY_SCHEMA: Readonly<Record<Agency, OpsSchema>> = {
  RDF: 'rdf_ops',
  RNP: 'rnp_ops',
  RCS: 'rcs_ops',
};

export function schemaForAgency(agency: Agency): OpsSchema {
  return AGENCY_SCHEMA[agency];
}

/**
 * The DB role every adapter in this service assumes. document_records has no
 * RLS (agency = schema), so the schema name in the query IS the isolation
 * boundary — which is why the mapping above lives in exactly one place.
 */
export const SYSTEM_ROLE = 'usrp_system_service';
