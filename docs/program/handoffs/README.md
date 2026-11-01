# Phase 0 front-end hand-offs (D7, D8, D10, D11)

Four notes, one per contract the front end must consume. They are written by the
backend/edge lane after the code shipped and the proofs passed, so each one is a
**consume**, not a re-derivation.

| Note | Defect | What the front end gains |
|---|---|---|
| [`D7-document-door-copy.md`](D7-document-door-copy.md) | D7 | one closed code set for the upload door, and copy chosen by *who must act* |
| [`D8-document-revision.md`](D8-document-revision.md) | D8 | `revision` on upload, `409 DOCUMENT_REVIEW_CLOSED` after review, the officer's revision trail |
| [`D10-vetting-hold-screen.md`](D10-vetting-hold-screen.md) | D10 | `POST /edge/v1/applications/vetting-hold`, the queue's `actions`, the SoD refusal |
| [`D11-field-score-sync-state.md`](D11-field-score-sync-state.md) | D11 | per-record sync outcomes, `OFFICER_MISMATCH` as a supervisor event |

Everything the labels need is exported from `@usrp/shared-types`; nothing here
asks the UI to hard-code a status, a code or a permission.

## What the front end must NOT do

- Do not call a service directly; the edge is the only door, and it is the only thing that knows the session.
- Do not hard-code a status code, a reason code or a permission: `DOCUMENT_DOOR_CODES`, `VETTING_HOLD_REASONS`, `AMBER_QUEUE_ACTIONS`, `FieldScoreRejectReason` and `AGENCY_DOCUMENT_TYPES` are exported for exactly this.
- Do not render a transition response into the detail cache: a transition returns a *result* (`fromStatus`/`toStatus`/`statusChanged`), not an application — re-read after a write.
- Do not show a forensics lane, score or flags on the citizen's upload screen, ever (forgery-tuning oracle).
- Do not treat a closed state as an error: `409 NOT_HELD` and `statusChanged: false` are successes of a race the console must absorb.
