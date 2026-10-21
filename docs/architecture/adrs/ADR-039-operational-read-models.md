# ADR-039 — Operational read models: admin campaigns, application search, venue roster, DPO queue, permission metadata

**Status:** Accepted (2026-10-21, S04). **Unblocks:** S05 (campaign list), S06
(officer workspace, DPO queue), S08 (field station roster), S09 (venue ops).
**Migration:** `rls/0035_operational_reads.sql` (indexes only; **no new write
grant, table, view, function or policy**).

## Context

The console could not run a campaign or a queue on the existing reads: the
public list shows only open campaigns, `listApplications` is capped at 100 with
no filter, cursor or total, there was no venue roster, the DPO queue was not on
the edge, and the OpenAPI did not say which permission an operation needs.

## Decision

1. **Agency is the session's, never an input.** Every read below runs in the
   owning service under the officer's own agency database role, so FORCE'd RLS
   (rls/0001, 0026, 0032) is the isolation, not a `WHERE`. No query key can carry
   an agency; an unknown query key is a 400. A sibling agency's campaign answers
   the same bare 404 as a nonexistent one.
2. **Keyset cursor, not offset.** `searchApplications` orders by
   `(COALESCE(submitted_at, created_at) DESC, id DESC)`. The cursor is the opaque
   base64url of `(sortKey, id)`; the sort key is a microsecond-precision UTC string
   (never a JS `Date`, which truncates to milliseconds and would re-serve a row).
   An insert between two page fetches can neither repeat nor skip a row. The cursor
   is not a security control: a forged one only moves the position inside the
   caller's own RLS-bound result. Page size 50, max 100. `total` is the count of the
   filtered set within the agency. Filters: `status[]`, `category`, `campaign`,
   `district`, submitted range.
3. **`listApplications` compatibility.** v1 keeps its exact response shape. The
   new read is a **separate operation, `searchApplications`** (versioned by name,
   `GET /edge/v1/applications/search`), so no existing client changes.
4. **Admin campaign reads.** `listAgencyCampaigns` returns all states with search,
   status filter and cursor (`idx_pc_campaigns_read_keyset`); `getCampaignAdminDetail`
   adds the sessions with `capacityLimit` and `registeredCount` (occupancy, ADR-026)
   and the policy version and hash. Permission `campaign.read.admin`.
5. **Roster minimisation rule.** `getVenueRoster(campaign, district, examDate)`
   returns, per candidate, only: processing code, category, status, admission state
   (`ADMITTED` / `NOT_ADMITTED`) and the required paper items; plus the venue header
   (name, district, date, reporting hour, capacity, registered count). **No name, no
   National ID, no phone, no applicant id.** The edge projection is an allowlist, so a
   field the service adds later does not leak. Hard ceiling 2,000 rows (a venue day is
   bounded by capacity); it is a roster, not a page. Any-of permission `admission.gate`
   or `field.score.sync` (`x-usrp-permission-also`); the field-ledger pre-download
   manifest uses the same shape.
6. **DPO queue on the edge.** `listErasureRequests` and `decideErasureRequest`.
   DECLINE needs written grounds. EXECUTE is composed at the edge: it resolves the
   applicant from the queue server-side and calls the gated erasure road, so the
   browser never holds an applicant id. The services already enforce
   `erasure.queue.read` / `erasure.decide`.
7. **Permission metadata convention.** Every officer operation in `edge-v1.yaml`
   declares `x-usrp-permission: <permission>` (`none` only for the session-local
   logout), `x-usrp-permission-also: [..]` where the registry has an any-of set, and
   `x-usrp-outcomes: { 409: [CODE..], 422: [CODE..] }` listing the union of
   business outcomes (`{}` when none). The edge-contract selfcheck fails the build if
   one is missing, if the permission differs from the registry, or if an outcome
   status has no documented response. The frontend drift gate reads them.
8. **Indexes (rls/0035).** `idx_<agency>_applications_read_keyset` (the expression
   above), `idx_<agency>_applications_roster (campaign_id, assigned_district)`
   partial, and `idx_pc_campaigns_read_keyset (agency, created_at DESC, id DESC)`.
   The status filter reuses the baseline `idx_<agency>_status`. All are mirrored in
   the `.schema.ts` files and the latest snapshot (schema-drift proof).

## Owner decisions

None required by the kit. No defaults were taken.

## Consequences

- Four read operations and two DPO operations are added; all reads are retry-safe.
- `listApplications` (v1) stays capped; consumers migrate to `searchApplications`.
- The Gasabo rehearsal roster is asserted by `pnpm rehearse --roster`.
