# D10 — resolving a held application (one verb: `adjudicate` + `lane`)

**From:** defect-closure phase 0, reconciled onto `main` · **Date:** 2026-11-01
**Rules:** every call goes through the edge (`/edge/v1/**`); officer session + CSRF on writes.

The amber queue lists three kinds of hold. They are all resolved by **one** operation:

```
POST /edge/v1/applications/adjudicate
{ applicationId, decision: 'CLEAR' | 'REJECT', lane?: 'DOCUMENT' | 'CRIMINAL' | 'ACADEMIC', notes? }
```

- Each queue row carries `heldLanes` (closed set). Render one action per lane and send that lane back. If a row is held in two lanes and `lane` is omitted the edge answers `409 ADJUDICATION_LANE_REQUIRED` with the lanes in `heldLanes`.
- `CLEAR` on CRIMINAL/ACADEMIC records the dimension as cleared and re-derives the status with the platform lifecycle; a row that lands green re-enters the slot lane.
- `REJECT` ends the application.
- `409 ILLEGAL_TRANSITION` means the hold is gone (another officer resolved it): re-read the queue.

**Four eyes on accept:** the officer who resolved a CRIMINAL or ACADEMIC hold gets `403 SEPARATION_OF_DUTIES` (rule `ACCEPT_EXCLUDES_CLEARANCE_REVIEWER`) if they later try to accept that application. Show it as "a second officer must accept this applicant".

**What you must not assume:** a resolved dimension is final. A late automated registry verdict never changes it.
