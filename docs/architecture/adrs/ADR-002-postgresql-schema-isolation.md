# ADR-002: PostgreSQL Schema Isolation over Separate Databases

**Status:** Accepted  
**Date:** 2025-07-02  

## Decision
Single PostgreSQL cluster with four isolated schemas: `public_core`, `rdf_ops`, `rnp_ops`, `rcs_ops`.

## Rationale
1. **RLS enforcement:** PostgreSQL Row-Level Security policies enforce cross-agency isolation 
   at the database engine level — not just application logic.
2. **Shared identity:** `public_core.applicant_identities` is shared by design — applicants 
   have one identity that multiple agencies may reference.
3. **Operational simplicity:** One cluster to backup, monitor, and maintain vs. four databases.
4. **Schema-level permission isolation:** PostgreSQL REVOKE at schema level prevents RDF officers 
   from even querying the existence of `rnp_ops` tables.

## Cross-Agency Data Access Rule
An applicant's identity record in `public_core` is readable by all agency services.
Recruitment data in `rdf_ops` is **never** accessible to `rnp_ops` or `rcs_ops` roles.
