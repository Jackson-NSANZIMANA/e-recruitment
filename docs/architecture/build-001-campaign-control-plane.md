# BUILD-001 — Campaign & Policy Control Plane

BUILD-001 adds campaign authoring and publication to the existing `application-service`, with session configuration and coverage owned by `scheduling-service`. It does not add a service or change legacy submission, reservation, or capacity behavior.

## Ownership and write ordering

- `application-service` owns campaign drafts, immutable `campaign_policy_versions`, lifecycle history, publication records, and campaign-command idempotency.
- `scheduling-service` owns `campaign_venue_assignments`, session-command idempotency, and `campaign_coverage_heads`. The existing slot reservation worker remains the only writer of `registered_count`.
- Every new session mutation and publication takes `recruitment_campaigns FOR UPDATE` first. A session mutation then locks the coverage head before reading/updating sessions. Publication locks the campaign, locks the head, and rereads the complete session set before validating it. The head's version/hash is evidence of the set, not the concurrency lock.
- Session writes and publication do not call each other synchronously. PostgreSQL row locks serialize their shared campaign aggregate.
- Session coverage is one session per district in BUILD-001. Multi-session districts, check-in/biometrics, field sync, notifications, global RBAC, and generic outbox redesign are out of scope.

## Lifecycle

The database and service allow exactly these BUILD-001 edges:

- `DRAFT → REGISTRATION_OPEN`
- `REGISTRATION_OPEN → REGISTRATION_CLOSED`
- `REGISTRATION_CLOSED → COMPLETED`
- `DRAFT → CANCELLED`
- `REGISTRATION_OPEN → CANCELLED`, only if the campaign has no applications

The legacy `EXAMINATION_ACTIVE` enum value is retained for compatibility; it is not a BUILD-001 transition. Published structure, selected policy version, publication evidence, and session coverage are frozen. A published campaign cannot receive a policy amendment in this build.

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

Campaign permissions are campaign-specific and composed with a verified officer principal. Agency and actor come from that principal, never from request input. Database roles remain agency-scoped; no system-service grant is broadened for campaign authoring.

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

Migration `packages/shared-database/src/migrations/0002_campaign_control_plane.sql` is the BUILD-001 DDL; authorization, RLS, immutable-fact guards, legal-edge enforcement, and lifecycle/session guards live in `packages/shared-database/src/rls/0026_campaign_control_plane.sql`. The RLS migration is applied by `scripts/bootstrap-db.sh` after 0025. Historical migrations are unchanged.

Successful draft, policy-version, session-coverage, publication, close, completion, and cancellation commands stage their campaign domain event(s), plus exactly one safe `AUDIT_ENTRY`, in the same database transaction as state and command rows. Domain events carry schema version, correlation ID, causation ID, and `piiClassification: NONE`. Immutable publication/history facts use deterministic event IDs; outbox delivery remains at-least-once. Replays do not add new outbox rows.

## Cancellation/submission serialization

Open-campaign cancellation checks the agency application table while holding the campaign row `FOR UPDATE` lock. The existing submission insert primitive obtains a narrow `FOR SHARE` campaign lock through `public_core.lock_campaign_for_application_insert` before creating the application. The helper is agency-bound for officer roles, exposes only campaign status, and adds no `UPDATE` grant to `usrp_system_service`. Therefore an in-flight application insert commits before cancellation checks for applications, or a cancellation commits first and the later insert observes the cancelled state and is rejected. P14 proves both orderings against live PostgreSQL.

## Registered proofs and execution record

The BUILD-001 self-checks are registered in `scripts/run-selfchecks.sh`:

- `verify-campaign-domain.ts` — P1–P4: draft/policy/session validation, normalization, and canonical-hash contract. Executed successfully, including NFC normalization, integer-looking object-key ordering, capacity rejection, and deterministic coverage hashing.
- `verify-campaign-control-plane.ts` — P5–P17 and the earlier 21 obligations: live PostgreSQL writes, RLS, lifecycle, idempotency, locking races, public/private projection, event/audit atomicity, and legacy preservation/migration assertions. Executed successfully against the bootstrapped PostgreSQL 16.14 database. This includes concurrent publication, publication/session-write and publication/close races, cancellation/submission serialization, completion/replay, and migration compatibility.
- `verify-edge-contract.ts` — edge registry, mounted routes, upstream catalogue, and OpenAPI drift. Executed successfully: 511 checks, including the completion route.
- `packages/shared-database/src/rls/verify-isolation.sql` — executed successfully; all agency-isolation assertions passed.
- `verify-schema-drift.ts` — executed successfully against the live database: 513 columns, 29 enums (including value order), and 91 named indexes match Drizzle; no catch-up migration was emitted.

The database-backed proof used the documented native-stack PostgreSQL fallback because Docker is unavailable in this sandbox. Bootstrap applied Drizzle migrations and RLS scripts 0001–0026, then seeded the development officer accounts. The focused scheduling slot-integrity proof passed all six sections, the edge-boundary proof passed 123 checks, and the shared rate-limit-store proof passed 23 checks. The full `scripts/run-selfchecks.sh` run completed with 45 proofs passed and 11 infrastructure-dependent proofs failed: Kafka round-trip/dead-letter, Kafka-backed vetting/eligibility/scheduling/audit/pipeline checks, MinIO+ClamAV forensics checks, and the all-services dev boot (which requires Kafka). Kafka, MinIO, and ClamAV are not part of the native fallback; no failure was reported in the BUILD-001 proofs. Root build passed 21/21 tasks, typecheck passed 36/36 tasks, `lint:count` returned 0, and `git diff --check` passed. Node 22.22.3 emits an engine warning because the workspace requests Node 24–25.
