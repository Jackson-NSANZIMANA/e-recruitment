# S09 — Device fleet and venue operations (backend)

**Phase 3 · backend · depends on S04** · Branch `feat/s09-fleet` · Reserved: **`rls/0036_device_fleet.sql`**

## Why
`public_core.field_devices` honours `revoked_at`, but nothing can set it. A lost tablet holds an enrolled signing key and, from B1 onward, biometric evidence capability. Supervisors also cannot see venue throughput. Gates G5 and G7 need both.

## Delivers
- Operations:
  - `listFieldDevices` (agency-scoped: enrolled by, enrolled at, last seen, last sync, pending count where reported, revoked);
  - `assignDeviceToVenueDay` (kit binding);
  - `revokeFieldDevice` (reason required; audited).
- A permission decision: recommend a new `field.device.manage` for `field_supervisor` and `agency_admin`, recorded in an ADR-036 addendum or the shared-auth role table comment (owner).
- **Last seen:** field-sync and biometric-service stamp `last_seen_at` on each signed contact (append-only contact log or a monotonic column; decide in `rls/0036`).
- **Revocation takes effect on next contact:** field-sync score sync, B1 evidence and enrolment all refuse a revoked device (proofs). The offline exposure window is documented: a revoked device that never reconnects keeps local data until the device wipe (S15 and operations runbook).
- **Venue live counts** (T11): per venue/day, expected (roster), admitted, physical captured, medical recorded, open conflicts. An event-driven projection with a visible `asOf` timestamp, read by S08's supervisor and S13 later.

## Read first
ADR-003/010, `field-sync-service/src/**` (device registry port and adapter), B1 hand-off (evidence path), S04 hand-off (roster shape), baseline §15.3 (device lost or stolen).

## Owns
- `services/field-sync-service/**`
- `rls/0036`
- the projection adapter in application-service (append-only)
- edge controllers for these operations

## Exit gate
- [ ] A revoked device is refused on its next score sync **and** its next biometric evidence (proofs).
- [ ] Venue counts match the rehearsal journey's actual admissions and captures (rehearsal assertion).
- [ ] CI green on the PR head; capability map (device revocation) updated; status board updated.

## Session starter
```text
You are a principal backend engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment.

This is session S09 — Device fleet and venue operations. Read your kit e-recruitment/docs/program/sessions/S09-fleet-venue-ops.md, docs/program/README.md and quality-workflow.md, and the S04/B1 hand-offs; follow them.

Goal: list, assign and revoke field devices (agency-scoped, audited), last-seen tracking, revocation enforced on the next score sync AND the next biometric evidence, and an event-driven per-venue/day live-count projection with an asOf timestamp.

Use rls/0036 only. Ask me the device-management permission decision first. /security-review is mandatory. Done = CI green on the PR head, rehearsal asserts venue counts, capability map and status board updated, hand-off note.
```
