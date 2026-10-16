# S04 — Operational read models (backend)

**Phase 2 · backend · depends on S01** · Branch `feat/s04-read-models` · Reserved: **ADR-039**, **`rls/0035_operational_reads.sql`**

## Why
The console cannot run a campaign or a queue on today's reads:
- the public campaign list shows only open campaigns;
- the officer application list is capped at 100, with no filter, cursor or total;
- there is no venue roster;
- the DPO queue is not on the edge;
- the OpenAPI does not say which permission an operation needs, so the frontend cannot check it.

S05, S06, S08 and S09 all consume this session.

## Delivers (each with a proof and an edge projection test)
| ID | Read | Notes |
|---|---|---|
| B-6 | `listAgencyCampaigns`: all states, search, status filter, cursor; plus `getCampaignAdminDetail` with sessions, `capacity_limit`, `registered_count` (occupancy), policy version and hash | permission `campaign.read.admin`; agency from the principal |
| BE-02 | `listApplications` v2: cursor (opaque, stable order), filters (status[], category, campaign, district, submitted range), `total` | Keep v1 response compatible, or version the operation (decide in ADR-039) |
| B-5 | `getVenueRoster(campaign, district, examDate)`: the minimum candidate set for a venue day (processing code, category, required paper items, admission state). **No names, no NIDs.** | permission `admission.gate` or `field.score.sync`; the field-ledger pre-download manifest uses the same shape |
| B-13 | `listErasureRequests`, `decideErasureRequest` (decline needs grounds) on the edge | the backend already enforces `erasure.queue.read`/`erasure.decide` at the service |
| BE-01 | `x-usrp-permission` on every officer operation in `edge-v1.yaml`; `x-usrp-outcomes` listing the 409/422 unions | the edge-contract selfcheck asserts every officer operation declares one |

## Read first
ADR-006 (projection), ADR-026 (slot ledger, `registered_count`), ADR-028, BUILD-001 doc (public allowlist; admin reads must stay agency-scoped), `services/application-service/src/adapters/*campaign*`, `edge-gateway/src/adapters/http/officer-reads.controller.ts`, identity-service erasure controllers.

## Owns
- the new read adapters in application, scheduling and identity services
- `rls/0035` (indexes and any read-only views; **no new write grants**)
- edge controllers for these reads
- ADR-039

**Append-only:** edge operations, OpenAPI, `run-selfchecks.sh`.

## Work plan
1. ADR-039: cursor design (keyset on `(submitted_at, id)`), compatibility of `listApplications`, the roster minimisation rule, and the permission-metadata convention.
2. One read at a time: the domain and adapter in the owning service → edge operation, controller and projection → proof (agency isolation, wrong permission, a cursor stable across inserts, a filter-empty state) → edge projection test.
3. Add `x-usrp-permission` and `x-usrp-outcomes` to **every** existing officer operation. Extend the edge-contract selfcheck so a missing one fails.
4. Rehearsal: the scenario asserts the roster for "Rehearsal Venue — Gasabo" today contains persona A's processing code and nothing identifying.

## Exit gate
- [ ] Proofs pass in CI on the PR head; edge-contract selfcheck enforces permission metadata.
- [ ] A frontend drift run against this branch reports the new operations (hand-off to S05, S06 and S08).
- [ ] Capability map updated; status board updated.

## Session starter
```text
You are a principal backend engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment.

This is session S04 — Operational read models. Read your kit e-recruitment/docs/program/sessions/S04-read-models.md, then docs/program/README.md and quality-workflow.md, and follow them.

Goal: agency-scoped admin campaign list and admin detail with session occupancy, a paginated and filterable officer application list with totals, a minimal venue roster (no names, no NIDs), the DPO erasure queue and decision on the edge, and x-usrp-permission / x-usrp-outcomes metadata on every officer operation, enforced by the edge-contract selfcheck.

Use ADR-039 and rls/0035 only (no new write grants). Done = CI green on the PR head, rehearsal asserts the Gasabo roster, capability map and status board updated, hand-off listing the new operation IDs for S05/S06/S08.
```
