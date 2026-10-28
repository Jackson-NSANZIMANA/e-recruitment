import type { Agency } from '@usrp/shared-types';

/** The agency's operational schema. Closed map: no string ever reaches SQL unchecked. */
const SCHEMAS: Readonly<Record<Agency, string>> = { RDF: 'rdf_ops', RNP: 'rnp_ops', RCS: 'rcs_ops' };

export function schemaForAgency(agency: Agency): string {
  const schema = SCHEMAS[agency];
  if (schema === undefined) throw new Error('Unknown agency');
  return schema;
}
