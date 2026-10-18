# S05 — Campaign Studio (frontend)

**Phase 2 · frontend · depends on S02 (the campaigns slice and typed operations); uses S04's admin list once merged** · Branch `feat/s05-campaign-studio` · Reserved: **ADR-FE-015**

## Why
Today only `pnpm rehearse` can create a campaign. Real agency administrators need a product that follows the **real four-step control plane** (BUILD-001: draft → immutable policy version → district sessions with coverage → publish). It must not be generic CRUD with a "published" checkbox.

## Delivers (officer console, `campaigns` slice)
1. **Campaign list:** all states (S04 `listAgencyCampaigns`; until S04 merges, intercepted specs labelled `CONTRACT-PENDING: S04`), filters, status lozenges, "new campaign".
2. **Basics:** public code, label (≤ 50 characters), categories restricted to the officer's agency, districts, registration window (Kigali time, shown explicitly), examination window, reporting hour, intake target, contacts, walk-in (offered only where `WALKIN_POLICY` allows it). Validation mirrors `campaign-validation.ts` (code token, chronology); the server stays authoritative and its 422 is rendered per field.
3. **Policy:** one complete entry per target category (age band and reference date, education mode and threshold, criminal threshold, required documents limited to the agency's accepted types, medical mode, legal basis).
   - Prefill from the engine constants, **visibly labelled "suggestion, confirm against the official announcement"**.
   - Show the returned **SHA-256** and the version number.
   - Show a **diff against the previous version**.
   - Values are never silently defaulted (the platform supplies no official thresholds).
4. **Sessions:** a district × exam-day grid; venue, reporting hour, capacity (or `UNBOUNDED_CAPACITY` with an explicit audited choice); a coverage meter (target districts without a session); occupancy once S04 lands.
5. **Preflight and publish:** a checklist (policy complete, coverage complete, capacity valid, windows coherent) and a **citizen preview** rendered with the applicant portal's campaign card. Publishing requires typing the public code. A structured 409 keeps the draft and points to the failing step.
6. **Lifecycle:** close registration, complete and cancel, each with a consequence summary (counts from S04 when available, otherwise "unavailable", never zero) and typed confirmation.
7. **Idempotency:** every write uses one `Idempotency-Key` per user intent, kept across retries of the same intent and renewed when the input changes (the apply-wizard pattern). Writes are never automatically retried.

## Read first
BUILD-001 doc, `campaign-validation.ts` (the rules to mirror), ADR-035 (the rehearsal does the same steps programmatically; read `tools/rehearsal/src/conductor.ts`), the frontend `AGENTS.md`, `features/applications/src/ui/ApplicationDetailPage.tsx` (the ConfirmAction pattern), the S02 hand-off.

## Owns
- `packages/features/campaigns/**`
- officer-console campaign routes
- `campaigns` locale namespace (en, rw, fr)
- surface manifest(s) `officer.campaign-studio*.json`
- ADR-FE-015

## Quality bar
- Every manifest state tested in mocked E2E: empty list, filtered-empty, validation, 409 on each step, replay, forbidden for non-admin
- **Live:** the live spec authors and publishes a campaign through the UI as `rdf.admin`, then the applicant portal lists it, then persona A applies to it
- ADS only; 48 px targets; trilingual

## Exit gate
- [ ] A campaign published through the Studio is **byte-equivalent in policy hash** to one staged by `pnpm rehearse` with the same inputs (proof that the UI drives the same control plane).
- [ ] CI green on the PR head; manifests at E2E-PROVEN; status board updated.

## Session starter
```text
You are a principal frontend engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Frontend: ~/Documents/projects/e-recruitment-software/e-recruitment-ui; backend for reading and running: ../e-recruitment.

This is session S05 — Campaign Studio. Read your kit e-recruitment/docs/program/sessions/S05-campaign-studio.md, then the backend's docs/program/README.md and quality-workflow.md, the frontend AGENTS.md, and the S02 hand-off; follow them.

Goal: an agency-admin Campaign Studio in the officer console that follows the real control plane (draft → immutable policy version with hash and diff → district/day session grid with coverage → preflight with citizen preview → publish; then close/complete/cancel), idempotent per user intent, trilingual and ADS-only, proven live by publishing a campaign through the UI and having persona A apply to it.

Use ADR-FE-015 only. Done = CI green on the PR head, manifests at E2E-PROVEN, status board updated, hand-off note.
```
