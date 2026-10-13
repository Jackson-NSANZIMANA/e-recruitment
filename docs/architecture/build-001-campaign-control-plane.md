# BUILD-001 — Campaign & Policy Control Plane

BUILD-001 adds campaign authoring and publication to the existing `application-service`, with session configuration and coverage owned by `scheduling-service`. It does not add a service or change legacy submission, reservation, or capacity behavior.

## Ownership and write ordering

- `application-service` owns campaign drafts, immutable `campaign_policy_versions`, lifecycle history, publication records, and campaign-command idempotency.
- `scheduling-service` owns `campaign_venue_assignments`, session-command idempotency, and `campaign_coverage_heads`. The existing slot reservation worker remains the only writer of `registered_count`.
- Every new session mutation and publication takes `recruitment_campaigns FOR UPDATE` first. A session mutation then locks the coverage head before reading/updating sessions. Publication locks the campaign, locks the head, and rereads the complete session set before validating it. The head's version/hash is evidence of the set, not the concurrency lock.
- Session writes and publication do not call each other synchronously. PostgreSQL row locks serialize their shared campaign aggregate.
- Session coverage is one session per district in BUILD-001. Multi-session districts, check-in/biometrics, field sync, notifications, global RBAC, and generic outbox redesign are out of scope.

## Lifecycle

The database and service allow exactly these BUILD-001 edges for new campaigns:

- `DRAFT → REGISTRATION_OPEN`
- `REGISTRATION_OPEN → REGISTRATION_CLOSED`
- `REGISTRATION_CLOSED → COMPLETED`
- `DRAFT → CANCELLED`
- `REGISTRATION_OPEN → CANCELLED`, only if the campaign has no applications

The legacy `EXAMINATION_ACTIVE` enum value remains for compatibility and cannot be entered by the BUILD-001 authoring path. A narrow upgrade exception allows an existing row with its deterministic `LEGACY-<32 uppercase hex>` public code to complete through `EXAMINATION_ACTIVE → COMPLETED`; the service, database transition guard, and lifecycle-history check agree on that exception. Other `EXAMINATION_ACTIVE` transitions remain illegal. Published structure, selected policy version, publication evidence, and session coverage are frozen. A published campaign cannot receive a policy amendment in this build.

## Commands and public reads

The edge contract is registered in the operation catalogue and OpenAPI document. It maps these paths to the existing services:

- `POST /edge/v1/campaigns`
- `POST /edge/v1/campaigns/policy`
- `POST /edge/v1/campaigns/session`
- `POST /edge/v1/campaigns/publish`
- `POST /edge/v1/campaigns/registration-close`
- `POST /edge/v1/campaigns/complete`
- `POST /edge/v1/campaigns/cancel`
- `GET /edge/v1/campaigns`
- `GET /edge/v1/campaigns/detail?publicCode=...`

Every write requires one UUID `Idempotency-Key`. A retry with the same actor, operation, key, and canonical request hash returns the stored original status/body and marks the response as replayed. Reusing that actor/operation/key with a different hash returns `IDEMPOTENCY_KEY_REUSED`. The command row stores the resource identity and response needed for replay; a replay does not stage duplicate events.

Public list reads contain only `REGISTRATION_OPEN` campaigns. Public detail is addressed only by `publicCode` and is available only for a code in the immutable publication ledger. The public allowlist contains campaign label/code, agency and externally relevant dates, target categories/districts, walk-in flag, and announcement contacts. It omits internal UUIDs, policy documents/thresholds/hashes, coverage hashes, capacity and registration counts, officer identities, audit data, and unpublished campaigns.

Campaign permissions are campaign-specific and composed with a verified officer principal. Agency and actor come from that principal, never from request input. Before a campaign/session command, the service adapter stores the verified subject UUID in the transaction-local custom setting `usrp.campaign_actor_id`; the command function requires that value to equal its `p_actor_id`. This catches actor substitution between service authorization and the database call.

This is an explicit trusted-backend boundary, not independent human authentication by PostgreSQL. `usrp_app` can set custom settings and can select service roles, so a compromised or buggy backend that deliberately sets both the context and command payload to another active agency administrator can still impersonate that administrator. The database verifies the backend login, the agency role, the transaction-context equality, and the active admin row; it does not cryptographically verify the officer token or prove that the UUID belongs to the human who sent the HTTP request. An ordinary reviewer token is denied by the service permission check; there is no claim that a reviewer can assume an owner or agency role. The DB proof queries actual role membership (`pg_has_role`) for `usrp_app` and the NOLOGIN function owners, while the live HTTP proof exercises the reviewer denial. Database roles remain agency-scoped; no system-service grant is broadened for campaign authoring.

`usrp_iam_service` now has SELECT-only access to `officer_accounts`; its direct and inherited INSERT/UPDATE grants are revoked, and the write-denial proof attempts both operations through IAM and the shared application login. Because `usrp_app` is a member of `usrp_iam_service`, every backend with the shared application credential can still read the cross-agency login credential store by selecting that role. This is a trusted-backend read boundary, not per-service isolation. The write-denial proof uses the shared `usrp_app` connection, explicitly `SET ROLE usrp_iam_service`, and attempts both INSERT and UPDATE; it separately checks a direct `usrp_app` INSERT denial. The development account seeder therefore requires a separate privileged local operator connection (`DEV_SEED_DATABASE_URL`), refuses to seed through `usrp_app`, and refuses to run when `NODE_ENV=production`; this does not create a production account-administration API. First-admin creation remains on the separate provisioner login described below.

## First administrator provisioning identity

`FIRST_ADMIN_DATABASE_URL` is intentionally separate from application database configuration and is never included in `.env.example`. To prove the dedicated provisioner credential against a real PostgreSQL server without creating an administrator, run `pnpm --filter @usrp/iam-service selfcheck:provisioner-auth` with that variable supplied through an approved local secret channel. The live `scripts/run-selfchecks.sh` runner also invokes this proof when (and only when) the variable is already present in its environment; it never prompts for or prints the secret. If the variable is absent, the runner records one skipped check and does not report `ALL PROOFS GREEN`, so that run is not complete BUILD-001 acceptance. The read-only proof opens a direct TCP connection, checks `session_user = current_user = usrp_iam_provisioner`, verifies the role's least-privilege attributes and grants, then invokes the provisioning function with invalid NULL inputs inside a savepoint. SQLSTATE `22023` confirms the direct session passed the function's login guard; the savepoint is rolled back, so no account or audit row is written. Credentials and connection details are not printed. This is a direct database-credential proof, not independent human-operator authentication or a substitute for real-PostgreSQL acceptance gates.

That proof establishes control of the database credential, not the human operator's identity. `FIRST_ADMIN_OPERATOR_REFERENCE`, correlation IDs, and confirmation environment variables are caller-supplied values; they are audit references, not authentication. No trusted operator IdP, PKI, or signed approval authority is configured in this repository, so human-operator identity remains unproven until an authoritative source and its verification/binding rules are selected. Do not claim human identity from a ticket string or database role alone.

## Canonical hashes — version 1

`@usrp/shared-security` is the sole implementation of campaign canonical JSON, policy hashing, coverage hashing, and deterministic campaign-fact UUIDs. Policy and coverage hash versions are exported from that package and re-exported by their owning domains.

For canonical campaign JSON v1:

1. Accept only JSON-compatible nulls, booleans, strings, finite numbers, arrays, and plain objects. Undefined values, non-finite numbers, sparse arrays, array custom properties, symbol keys, accessors, non-enumerable object properties, exotic object prototypes, and NFC-colliding object keys are rejected.
2. Normalize every string value and object key to Unicode NFC.
3. Sort object keys by ascending UTF-16 code-unit order. Preserve array element order. Validators sort fields that are contractually sets (for example, target categories, districts, and required document types) before hashing.
4. Serialize as compact ECMAScript JSON with no insignificant whitespace. `null` is emitted explicitly. Finite numbers use ECMAScript's shortest round-trippable representation; negative zero is normalized to `0`.
5. Encode the resulting text as UTF-8 without a BOM and SHA-256 hash those bytes. The digest is lowercase hexadecimal.

The policy digest covers exactly `legalBasisCode`, `legalBasisReference`, and `policyDocument`. `publicCode` is command context, not part of the policy document digest. The hash is not an official policy decision and this implementation supplies no government thresholds or values; missing or uncertain values must be supplied by an authorized policy owner.

The coverage digest hashes canonical JSON containing the campaign ID and sessions. Each session includes district, province, NFC venue name, exam date, reporting hour, capacity, and active status. Sessions are sorted deterministically by district, province, exam date, venue name, reporting hour, capacity (null first), then active status. Mutable `registered_count` is deliberately excluded. Thus a capacity/configuration change changes the coverage digest while a reservation count does not.

## Database, events, and audit

Migrations `packages/shared-database/src/migrations/0002_campaign_control_plane.sql` and `0003_build_001_boundary_columns.sql` provide the campaign DDL and later boundary columns. Migration `0004_build001_completion_and_capacity_constraints.sql` mirrors the venue-capacity decision check and records the legacy completion edge in Drizzle's schema snapshot. Authorization, RLS, immutable-fact guards, legal-edge enforcement, and lifecycle/session guards begin in `packages/shared-database/src/rls/0026_campaign_control_plane.sql`; direct campaign/session DML revocation, private command owners, and operation-specific `SECURITY DEFINER` functions live in `packages/shared-database/src/rls/0027_campaign_command_functions.sql`. `scripts/bootstrap-db.sh` applies the schema migrations before the corresponding RLS command boundary. The RLS files are deliberately replayable; `verify-build001-populated-upgrade.ts` applies the manifest parsed from `bootstrap-db.sh` twice against populated rows and attempts denied writes after both replays. This forward migration does not rewrite legacy statuses or session data.

Successful draft, policy-version, session-coverage, publication, close, completion, and cancellation commands stage their campaign domain event(s), plus exactly one safe `AUDIT_ENTRY`, in the same database transaction as state and command rows. Domain events carry schema version, correlation ID, causation ID, and `piiClassification: NONE`. Immutable publication/history facts use deterministic event IDs; outbox delivery remains at-least-once. Replays do not add new outbox rows.

## Cancellation/submission serialization

Open-campaign cancellation checks the agency application table while holding the campaign row `FOR UPDATE` lock. The existing submission insert primitive obtains a narrow `FOR SHARE` campaign lock through `public_core.lock_campaign_for_application_insert` before creating the application. The helper is agency-bound for officer roles and exposes only campaign status. Its NOLOGIN function owner can SELECT only campaign `id`, `agency`, and `status`; PostgreSQL requires UPDATE privilege on at least one column for `SELECT ... FOR SHARE`, so the owner receives only column-level UPDATE on `updated_at`, not table-wide UPDATE or UPDATE on state/configuration columns. `usrp_app` cannot assume that owner. The shared system role gets no direct campaign UPDATE grant. Therefore an in-flight application insert commits before cancellation checks for applications, or a cancellation commits first and the later insert observes the cancelled state and is rejected. The live-PostgreSQL ordering proof is registered in P14 but was not executable in this sandbox.

## Registered proofs and current validation status

The BUILD-001 checks are registered in `scripts/run-selfchecks.sh`. Results below describe this remediation checkout only; historical execution notes for earlier checkpoints are not evidence for this source state.

### Executed in this checkout

- `pnpm build` — passed, 21/21 tasks.
- `pnpm typecheck` — passed, 36/36 tasks. The environment is Node `v22.22.3`; the workspace requests Node `>=24 <=25`, so pnpm emitted an engine warning.
- `bash scripts/refresh-schema-snapshot.sh` — passed; Drizzle reported no schema changes and the TypeScript schema agrees with the checked-in snapshot. This validates snapshot generation only, not a live database.
- `services/edge-gateway/selfcheck/verify-edge-contract.ts` — passed, 511 checks. It was given a syntactically valid `DATABASE_URL` and required gateway configuration; it is a static route/catalogue/OpenAPI proof and did not connect to PostgreSQL.
- `services/edge-gateway/selfcheck/verify-campaign-http-boundary.ts` — 13 checks passed, including reviewer permission denial and the completion-only legacy-code route.
- `services/application-service/selfcheck/verify-campaign-domain.ts` — P1–P4 passed.
- `services/scheduling-service/selfcheck/verify-campaign-session-validation.ts` — 8 checks passed.
- Standalone TypeScript compilation passed for `verify-build001-populated-upgrade.ts` and `verify-slot-integrity.ts`; this checks proof-source typing, not their database behavior.
- The dev officer seeder refused `NODE_ENV=production` before opening a database connection.
- `pnpm lint:count` — passed with 0 lint findings.
- `git diff --check` — passed.

### Real-PostgreSQL acceptance remains unverified

This sandbox has no `docker`, `podman`, `psql`, or `pg_ctl`, no PostgreSQL listener on port 5432, and no configured live database URL. No PostgreSQL statement from the new migration/RLS files was executed here. Therefore these database-backed proofs were **not run**: `verify-campaign-control-plane.ts` (including account-write denial and outbox forgery), `verify-build001-populated-upgrade.ts` (populated migration plus two full RLS-bootstrap replays and fail-closed assertions), `verify-slot-integrity.ts` (including release-at-zero), and `verify-first-admin-provisioner-auth.ts` (no `FIRST_ADMIN_DATABASE_URL` was supplied). The full `scripts/run-selfchecks.sh` gate was not run because its live infrastructure prerequisites are absent. No claim is made here about PostgreSQL SQL execution, live ACL/RLS behavior, migration upgrade behavior, row-lock races, or provisioner authentication. PGlite is not used as a substitute.

### Exact follow-up commands

Run these against real PostgreSQL after the database is bootstrapped; provide secrets through the approved environment/secret channel, not in chat. The populated-upgrade proof creates its own disposable database and needs an admin URL with `CREATEDB` and permission to drop that generated database.

```bash
ADMIN_DATABASE_URL="$ADMIN_DATABASE_URL" pnpm exec tsx packages/shared-database/selfcheck/verify-build001-populated-upgrade.ts

DATABASE_URL="$DATABASE_URL" ADMIN_DATABASE_URL="$ADMIN_DATABASE_URL" \
  pnpm exec tsx services/application-service/selfcheck/verify-campaign-control-plane.ts

DATABASE_URL="$DATABASE_URL" ADMIN_DATABASE_URL="$ADMIN_DATABASE_URL" \
PII_ENCRYPTION_KEY="$PII_ENCRYPTION_KEY" \
  pnpm exec tsx services/scheduling-service/selfcheck/verify-slot-integrity.ts

FIRST_ADMIN_DATABASE_URL="$FIRST_ADMIN_DATABASE_URL" \
  pnpm --filter @usrp/iam-service selfcheck:provisioner-auth
```

After those focused gates pass, run `bash scripts/run-selfchecks.sh` with the repository's documented live infrastructure available. Record PostgreSQL server version, the actual session/database roles, migration source state, exact commands, and results separately. Until then, the BUILD-001 database/security acceptance gate remains **UNVERIFIED**.
