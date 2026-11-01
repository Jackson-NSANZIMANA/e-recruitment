# ADR-051 — Resolving a vetting hold: one verb, four eyes, and a human decision no machine overwrites

**Status:** Accepted (reconciled) · 2026-11-01 · closes evaluation 2026-10-29 defect **D10**
**Supersedes:** the first draft of this ADR, which proposed a *second* endpoint (`POST /v1/applications/vetting-hold`, nine closed reasons, a `vetting.hold.resolve` permission). That draft was written before PR #58 shipped the lane-aware `adjudicate`; two verbs for one concept is the second-source-of-truth this ADR exists to prevent, so the endpoint was **not** built.
**Relates to:** ADR-011 amber lane, ADR-006 single writer, ADR-031 operation permissions and separation of duties, ADR-048 identity binding, ADR-050 re-drive
**Migration:** `rls/0047_vetting_hold_resolution.sql` (renumbered from 0045 at rebase; 0043/0044 belong to the cross-agency parity and clearance-escalation fixes already on `main`).

## 1. Decision

1. **There is one verb.** `POST /edge/v1/applications/adjudicate` with `lane ∈ {DOCUMENT, CRIMINAL, ACADEMIC}` (shipped in #58) resolves every hold the amber queue lists. The queue names each row's `heldLanes` from the same pure predicate (`domain/adjudication-lanes.ts`) the verb checks under the row lock, so the screen cannot offer a button the verb refuses. No new route, permission or role.
2. **Four eyes on accept.** The officer who resolved a CRIMINAL or ACADEMIC hold on an application may not accept it (`ACCEPT_EXCLUDES_CLEARANCE_REVIEWER`, config `SOD_CLEARANCE_REVIEW_EXCLUDES_ACCEPTER`, **default on**). The fact is durable on the row as a **set** — `vetting_hold_resolvers uuid[]` and `vetting_hold_resolved_dimensions text[]` in all three ops schemas — because a row held in two dimensions can be resolved by two officers, and a last-writer-wins column would let the first of them accept.
3. **A human decision outranks a machine verdict.** Once a dimension is in `vetting_hold_resolved_dimensions`, the vetting projection acknowledges any later automated verdict for it as `NO_CHANGE` (and logs `vetting_verdict_after_human_decision`). This matters because the durable re-driver (ADR-050) can replay an old event hours later; without this rule a replayed `CLEARED` could flip an officer's decision.
4. **REJECT is a decision about the application.** On the CRIMINAL/ACADEMIC lanes `REJECT` ends the application (`REJECTED`), as it does on the document lane; the dimension column keeps the registry's evidence. There is no separate `CONFIRM` evidence write.

## 2. Consequences

- The FE contract is the existing `adjudicate` + `heldLanes`; see `docs/program/handoffs/D10-vetting-hold-screen.md`.
- Closed reason codes per resolution (the first draft's nine) are **deferred**: `notes` remains the officer's free text, audit-only. Adding a required field would break the shipped contract; it is a follow-up if the owner wants structured reasons.
- Proof: `services/application-service/selfcheck/verify-hold-resolution.ts` (zero infrastructure, registered in `scripts/run-selfchecks.sh`). The race/lock behaviour needs the live selfcheck on the owner's machine.
