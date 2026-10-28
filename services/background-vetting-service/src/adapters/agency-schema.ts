import type { Agency } from '@usrp/shared-types';

/** The agency's operational schema. A closed map: no string ever reaches SQL unchecked. */
const SCHEMAS: Readonly<Record<Agency, string>> = { RDF: 'rdf_ops', RNP: 'rnp_ops', RCS: 'rcs_ops' };

export function schemaForAgency(agency: Agency): string {
  return SCHEMAS[agency];
}
