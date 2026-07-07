# Data Layer Verification — 2026-07-07

Empirical verification of the USRP data layer against a live PostgreSQL 16
instance (Tier-1 docker stack). Performed during handover, before building
the first service, to confirm the foundation's core correctness claims hold
in reality rather than on paper.

## Verified ✓

| Claim | Method | Result |
|-------|--------|--------|
| Schemas exist (`public_core`, `rdf_ops`, `rnp_ops`, `rcs_ops`, `audit_log`) | live introspection | ✓ 5 schemas, tables present |
| Migration applied | `public.drizzle_migrations` | ✓ 1 migration |
| Extensions (`pgcrypto`, `uuid-ossp`) | `pg_extension` | ✓ present |
| RLS enabled **and forced** on `applicant_identities` | `pg_class` flags | ✓ `t / t` |
| Policies `pc_ai_{system,rdf,rnp,rcs}` present | `pg_policy` | ✓ all 4 |
| **Cross-agency isolation** — RDF officer cannot see an RNP-only applicant | `rls/verify-isolation.sql` | ✓ hidden by RLS |
| Officer denied cross-schema query (`rnp_ops` from RDF role) | same | ✓ `insufficient_privilege` |
| System service sees all applicants (cross-agency vetting) | same | ✓ sees both |
| PII encryption round-trips (pgcrypto AES) | encrypt→decrypt | ✓ correct key works |
| PII wrong-key rejected | decrypt w/ wrong key | ✓ `Wrong key or corrupt data` |

The isolation proof is committed as a **repeatable regression test**:
`packages/shared-database/src/rls/verify-isolation.sql` (transactional,
rolls back, exits non-zero on any leak or failure).

```
docker exec -e PGPASSWORD=usrp_dev_password usrp-postgres \
  psql -U usrp_admin -d usrp_db -v ON_ERROR_STOP=1 \
  -f /tmp/verify-isolation.sql
```

## Finding: three divergent role models in the repo ⚠

The database role/grant design is expressed **three different ways** across
the repo, and they do not agree. The live DB currently reflects (3), the
strongest — but the inconsistency is a latent trap for whoever wires service
connection strings next.

1. **`infrastructure/docker/init-scripts/02-create-roles.sql`** — officer
   roles as `LOGIN` with direct schema grants; `03-rls-policies.sql` is only
   a placeholder (no real policies). Implies officers connect *directly*.
2. **`.env.example`** — references roles that exist in neither SQL file
   (`usrp_system`, `usrp_public_reader`) and per-schema `search_path` DSNs.
3. **`packages/shared-database/src/rls/0001_roles_grants_rls.sql`** — officer
   roles as `NOLOGIN` group roles; a single `usrp_app` LOGIN assumes them via
   `SET ROLE`; **FORCE'd RLS** policies. This is what the live DB runs, and
   what the isolation proof validates.

**Recommendation (architect):** adopt **(3)** as the single source of truth.
- `usrp_app` is the one application login; services select an agency context
  per-request via `SET ROLE` (or `SET LOCAL ROLE` inside a transaction).
- Delete/relegate the `LOGIN` officer roles from (1); make `03-rls-policies`
  either point at (3) or be removed to kill the placeholder ambiguity.
- Reconcile `.env.example` to the `usrp_app`-based DSN (one connection role),
  documenting the `SET ROLE` model rather than four per-officer logins.

Tracked for the shared-database hardening pass; not blocking the first
service slice, which connects as the system service for identity creation.
