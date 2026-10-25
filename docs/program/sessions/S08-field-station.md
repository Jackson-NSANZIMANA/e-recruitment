# S08 — Field Station, online-first (frontend)

**Phase 3 · frontend · depends on S02 (app, field-ledger, moved gate); uses S04 roster and B1 evidence** · Branch `feat/s08-field-station` · Reserved: **ADR-FE-016** (only if it deviates from FE-010/011)

## Why
This session replaces six placeholders:
- `field-ops/index`, `check-in` ✱, `conflicts` ✱, `walk-in` ✱
- `scheduling/index`, `verify-invitation` ✱

Exam day becomes a station-based workflow on a managed Android tablet: **online-first**, with every record written locally first and never claimed as synced until the server acknowledges it. Durable offline capture is S15, and `OFFLINE_CAPTURE_CAN_SYNC` stays `false`.

## Delivers (field-station app; field-ops and scheduling slices)
1. **Setup and readiness:**
   - device readiness check: `navigator.storage.persisted()`, quota headroom, Ed25519 WebCrypto support, clock skew against the edge `Date` header, enrolment state, build version;
   - venue and day selection, from S04's roster/sessions when available, otherwise typed and confirmed;
   - **device enrolment** (`enrollFieldDevice`) with a non-extractable key held by `field-ledger`'s `SignerPort`.

   A failed check blocks the stations and points to the paper fallback.
2. **Station picker**, derived from the session's permissions (never a free choice): Gate, Paper documents, Physical, Medical, Walk-in (RDF only), Supervisor.
3. **Gate:**
   - the moved `admitAtGate` flow, plus paper-document sighting (`getDocumentChecklist` → `verifyDocumentAtVenue`, a write-once mark per item);
   - the B1 hook point for biometric evidence (B2 fills it);
   - **degraded rung:** offline signature verification of the `USRP-SLOT.v1` QR with the cached scheduling public key (from the `scheduling` slice). It shows valid or invalid and venue/day, and **cannot spend the QR**; it routes to the supervised lane.
4. **Physical:** single-candidate capture written to the ledger first (`LOCAL_ONLY`), signed, sent through `syncFieldScores`, with a per-record acknowledgement mapped from the real response union (never "synced" on HTTP 200 alone). Bounds come from `PhysicalTestMetrics`; out-of-range values need a remeasure reason.
5. **Medical:** the agency mode from the session (RDF BOARD; RNP/RCS CERTIFICATE with the physician name), via `recordMedicalReview`.
6. **Walk-in:** the moved, already-fixed flow (category Select and academic reference).
7. **Supervisor:** sync centre (queue depth, per-record state, last success) and conflicts (`resolveFieldSyncConflict`; both signed records shown; a reason is mandatory; resolution appends).
8. **Ergonomics:** landscape layout, sunlight-readable positive polarity, 48 px targets, glove-friendly, a station header that always shows venue, day, station and network state.

## Read first
Revamp plan §2.5 and §2.6; ADR-034, ADR-003/010, ADR-012 and ADR-013 (backend); the field-sync contract in `edge-v1.yaml`; the S02 hand-off (`field-ledger` API); baseline §15.3 (degradation ladder).

## Owns
- `apps/field-station/src/**` (routes)
- `packages/features/{field-ops,scheduling}/**`
- field locales
- field manifests

## Quality bar
- Unit tests of every response-union → sync-state mapping, from the generated fixtures
- Mocked E2E for every station state, with the `field-tablet` Playwright device
- **Live:** in field-station, persona A goes setup → enrol → Gate (admit plus paper sighting) → Physical (signed, acknowledged) → Medical; then the officer console shows the records; a network drop mid-capture leaves the record `LOCAL_ONLY` with the paper prompt

## Exit gate
- [ ] The six placeholders are replaced; manifests at E2E-PROVEN.
- [ ] The live field journey passes; the offline drop is visibly *not* claimed as synced.
- [ ] CI green on the PR head; status board updated; B2 unblocked.

## Owner decisions (ask; default if no answer)
| Decision | Default |
|---|---|
| Pilot agency (fixes the medical mode) | **Decided for the sandbox (2026-10-25): RNP Basic 2025 is the target campaign.** Build the medical station for all three agency modes (RDF board verdict; RNP and RCS government-physician certificate, ADR-013), and prove RNP end to end. The real pilot agency is still the owner's decision before M4. |
| Managed device model | one Android model, Chrome pinned |
| Who enrols devices | **Decided (2026-10-21):** `field.device.manage` for `field_supervisor` and `agency_admin` (S09) |

### Addendum (2026-10-25): what this session must close
- **The Basic Course life cycle breaks today at the physical test:** the backend accepts signed scores, but there is no station screen. Physical capture (ledger-first, signed, acknowledged per record) and medical are the critical path for S12c's live journeys.
- **Gate:** keep the merged camera/hand-held QR scan and the national-ID check. Add the biometric step as *evidence only* behind the B1 policy read (`getBiometricPolicy`): in SHADOW, nothing is shown; capture itself is B2.
- **Venue roster and live counts:** use S04's `getVenueRoster` and S09's venue live counts on the supervisor station.
- **Walk-in:** the RDF lane exists; walk-in is enabled per campaign once S12c's policy v2 lands. Don't hard-code the agency.
- **Data sources:** campaigns and venues come from docs/product/recruitment-announcements-2025-2026.md (via S12a's rehearsal scenarios), never from the English translations.

## Session starter
```text
You are a principal frontend engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Frontend: ~/Documents/projects/e-recruitment-software/e-recruitment-ui; backend for reading and running: ../e-recruitment.

This is session S08 — Field Station, online-first. Read your kit e-recruitment/docs/program/sessions/S08-field-station.md, the backend's docs/program/README.md and quality-workflow.md, the frontend AGENTS.md and the S02/S04 hand-offs; follow them.

Goal: in apps/field-station, device setup and readiness with WebCrypto enrolment, a permission-derived station picker, and Gate (admission + paper sighting + offline signature check as a degraded rung that cannot spend the QR), Physical (ledger-first, signed, acknowledged per record), Medical (agency mode), Walk-in and Supervisor (sync centre, conflicts) — replacing six placeholders. OFFLINE_CAPTURE_CAN_SYNC stays false; never claim "synced" without a server acknowledgement.

Prove it with the live field journey for persona A. Done = CI green on the PR head, manifests E2E-PROVEN, status board updated, hand-off note for B2.
```
