# S06 — Officer workspace, queues and staff administration (frontend)

**Phase 2 · frontend · depends on S01 (staff operations) and S02; uses S04 (list v2, DPO) and B1 (evidence read) when merged** · Branch `feat/s06-officer-workspace`

## Why
This session replaces five of the sixteen placeholders:
- `adjudication/index` and `amber-queue` ✱
- `applications/list` and `detail` (the workspace moves into the slice)
- `compliance/index` and `dpo-queue` ✱

It also gives agency administrators the screens to operate the permission model that S01 makes possible. Wave 1 of the frontend revamp plan (W1-01…W1-08) is this session.

## Delivers
1. **`packages/ui` state patterns:**
   - `StateBoundary` (loading, empty, filtered-empty, forbidden, not-found, partial, stale, upstream-failure, conflict)
   - `QueueTable` (age, last action, permitted transition)
   - `ConfirmAction` (lifted from `ApplicationDetailPage`)
   - `Timeline`, `MaskedValue`, `FreshnessStamp`

   Each has Storybook stories and a11y checks.
2. **Application workspace, moved into `features/applications`:**
   - the list on S04's cursor and filters (until then a visible "first 100" notice);
   - **Applicant 360** tabs: summary (masked), status timeline, document checklist with venue-verified marks, slot and invitation, gate admission and **biometric evidence** (B1 read, shown as evidence, never as a verdict), field records, medical;
   - transitions: medical (agency mode from the session), final, accept (`409 CROSS_AGENCY_LOCKED` names the holding agency), adjudicate.
3. **Queues:** amber documents (forensic signal shown, null = "not analysed"); post-clearance holds; medical; final decision (bulk = a per-record loop with a per-row result); DPO erasure queue with mandatory decline grounds (S04 B-13). Remove the obsolete `DPO_AUTHORITY_GAP` banner only once the edge enforces the DPO permission.
4. **Staff administration** (S01 operations), for `agency_admin` only:
   - officer list;
   - create, then show the one-time activation code exactly once with a copy-and-print step;
   - assign posts with the reason required (show which operations a post grants, read from the shared role table);
   - disable/enable;
   - revoke sessions.

   The officer's own row is read-only (no self-escalation in the UI either). Every action uses a ConfirmAction with consequences ("this officer will be signed out now").
5. **Permission-built navigation** from the session view; a forbidden route renders the forbidden state.
6. **Paper-fallback print sheets** (W1-08) for the field: numbered score sheet and roster template (roster pre-fill from S04's venue roster).

## Read first
`frontend-revamp-plan` Wave 1 and §2.7; ADR-031, ADR-011, ADR-013, ADR-014 and ADR-017 (backend); the S01 and S04 hand-offs; `docs/ui-surfaces/officer.application-workspace.json`.

## Owns
- `packages/features/{applications,adjudication,compliance}/**`
- `packages/ui/**` (new components)
- officer-console navigation and staff routes
- their locale namespaces
- their manifests

## Quality bar
- Every manifest state tested, with role fixtures for each post (negative navigation tests)
- **Live:** `rdf.admin` creates an officer, they activate, `rdf.admin` assigns `medical_officer`, the officer records a medical verdict on persona A, `rdf.director` decides and accepts, the citizen sees the outcome; then `rdf.admin` disables the officer and their open session ends

## Exit gate
- [ ] The five placeholders are replaced and their manifests are at E2E-PROVEN.
- [ ] The live staff-and-decision journey passes.
- [ ] CI green on the PR head; status board and capability map (officer UI rows) updated.

## Session starter
```text
You are a principal frontend engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Frontend: ~/Documents/projects/e-recruitment-software/e-recruitment-ui; backend for reading and running: ../e-recruitment.

This is session S06 — Officer workspace, queues and staff administration. Read your kit e-recruitment/docs/program/sessions/S06-officer-workspace-staff-admin.md, the backend's docs/program/README.md and quality-workflow.md, the frontend AGENTS.md, and the S01/S02/S04 hand-offs; follow them.

Goal: the shared state components in packages/ui; the application workspace moved into the applications slice with Applicant 360 (including biometric EVIDENCE, never a verdict); the amber, hold, medical, final and DPO queues; and agency-admin staff administration (create with one-time activation code, assign posts with reasons, disable, revoke sessions) — replacing five placeholder routes — proven by a live journey where an admin provisions a medical officer who records a verdict before the director decides and accepts.

Done = CI green on the PR head, manifests E2E-PROVEN, status board and capability map updated, hand-off note.
```
