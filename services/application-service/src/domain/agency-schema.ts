// ══════════════════════════════════════════════════════════════════
// application-service — Agency → ops-schema routing (single source of truth)
//
// Both write paths — the front-door createApplication (INSERT) and the
// vetting-result projection (UPDATE) — must target the OWNING agency's
// isolated ops schema. There is no row-level security on the ops
// `applications` tables: cross-agency isolation is enforced by schema GRANTs,
// so "the agency IS the schema". Because the engine will NOT stop a mis-routed
// write, choosing the right schema here is a correctness/compliance boundary —
// hence one hard-coded, user-input-free mapping shared by both adapters.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

export type OpsSchema = 'rdf_ops' | 'rnp_ops' | 'rcs_ops';

/** Per-agency write target — fixed mapping, never derived from user input. */
export interface AgencyTarget {
  readonly schema: OpsSchema;
  readonly codePrefix: 'RDF' | 'RNP' | 'RCS';
}

export const AGENCY_TARGET: Readonly<Record<Agency, AgencyTarget>> = {
  RDF: { schema: 'rdf_ops', codePrefix: 'RDF' },
  RNP: { schema: 'rnp_ops', codePrefix: 'RNP' },
  RCS: { schema: 'rcs_ops', codePrefix: 'RCS' },
};

/** Resolve the owning ops schema for an agency. */
export function schemaForAgency(agency: Agency): OpsSchema {
  return AGENCY_TARGET[agency].schema;
}
