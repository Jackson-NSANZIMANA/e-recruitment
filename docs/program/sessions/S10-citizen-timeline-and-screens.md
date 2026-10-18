# S10a — Citizen timeline and notices (backend) → S10b — Citizen completeness (frontend)

## S10a (backend)
**Phase 3 · depends on S04** · Branch `feat/s10a-citizen-timeline` · Reserved: **ADR-041**, **`rls/0037_citizen_timeline.sql`**

### Why
Citizens see only a top-level status. They cannot see which check is pending, why an application is on hold, or which messages were sent. That is the capability map's BUILD-005.

### Delivers
- `getMyApplicationTimeline`:
  - a citizen-safe status history plus per-gate state (age, academic, criminal, documents, slot, admission) as `PENDING | CLEARED | NOT_CLEARED | ON_HOLD | NOT_APPLICABLE`;
  - **never** raw RIB detail, forensic scores, internal reasons, officer identities, or biometric scores;
  - ownership comes from the session subject (OWASP API1).
- `getMyNotices`: the per-applicant notification log, with delivery state from the provider (today `ACCEPTED` from `LogSmsChannel`; never claim "delivered" without a receipt), with bodies re-rendered from templates (OTP bodies excluded).
- A rejection **reason category** only if the owner approves a disclosure policy. Otherwise the timeline shows "closed" with the stage, not the reason (ADR-041 records the decision).

### Exit gate
- [ ] Proofs: ownership (another citizen's application is a 404 indistinguishable from not-found); no forbidden field in any response (allowlist test); timeline matches the status history for personas A and B in the rehearsal.
- [ ] CI green; capability map updated.

### Session starter
```text
You are a principal backend engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment.

This is session S10a — Citizen timeline and notices. Read your kit e-recruitment/docs/program/sessions/S10-citizen-timeline-and-screens.md (part S10a), docs/program/README.md and quality-workflow.md; follow them.

Goal: a citizen-safe application timeline with per-gate state and a per-applicant notice log with truthful delivery state, owner-scoped from the session, with an allowlist proof that no RIB detail, forensic score, internal reason, officer identity or biometric score can leave. Ask me the rejection-disclosure decision first.

Use ADR-041 and rls/0037 only. Done = CI green on the PR head, rehearsal asserts personas A and B timelines, capability map and status board updated, hand-off note for S10b.
```

## S10b (frontend)
**Phase 3 · depends on S10a and S02** · Branch `feat/s10b-citizen`

### Why
The applicant portal has the core journey, but not the breadth a citizen needs. This session replaces the `compliance/withdraw` ✱ placeholder.

### Delivers
- Campaign catalogue and shareable `/campaigns/:publicCode` detail pages, with the rehearsal marker.
- The document checklist screen (received ≠ verified; no lane, score or flag ever shown).
- A **six-stage tracker** (`toCitizenStage` over all statuses, exhaustively tested), with per-gate detail from S10a and "auto-withdrawn because accepted elsewhere" worded distinctly.
- **Privacy centre:** withdraw (the placeholder) and erasure request and status, with DPO-approved copy.
- **Notice inbox** from S10a.
- Low-bandwidth behaviour: every step survives a reload; trilingual; tested on the Pixel 5 project.

### Exit gate
- [ ] The placeholder is replaced; manifests at E2E-PROVEN.
- [ ] Live: persona A sees each stage advance and the admission; persona B sees a closed application with no pass.
- [ ] CI green on the PR head; status board updated.

### Session starter
```text
You are a principal frontend engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Frontend: ~/Documents/projects/e-recruitment-software/e-recruitment-ui; backend for reading and running: ../e-recruitment.

This is session S10b — Citizen completeness. Read your kit e-recruitment/docs/program/sessions/S10-citizen-timeline-and-screens.md (part S10b), the backend's docs/program/README.md and quality-workflow.md, the frontend AGENTS.md and the S10a hand-off; follow them.

Goal: campaign catalogue and detail pages, the document checklist screen, a six-stage tracker backed by the citizen timeline, a privacy centre (replacing the withdraw placeholder) and a notice inbox — trilingual, low-bandwidth-safe, never showing forensic or internal data — proven live with personas A and B.

Done = CI green on the PR head, manifests E2E-PROVEN, status board updated, hand-off note.
```
