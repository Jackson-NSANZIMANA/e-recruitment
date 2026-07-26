# ADR-020 — Applicant Self-Service: Voluntary Withdrawal + Erasure Request Intake

**Status:** Accepted (owner-signed 2026-07-26, decisions D10/D11)
**Related:** ADR-017 (auto-withdrawal — WITHDRAWN's first writer; this is the second), ADR-018 (applicant sessions — the authentication this rides on), ADR-015 (erasure — the road the intake feeds), ADR-016 (system tokens — the portal→application-service authority), `docs/compliance/erasure-sop.md`
**Legal frame:** Law N° 058/2021 — the data subject's own acts. *Engineering position; SOP updates remain DRAFT pending DPO sign-off.*

## Context

After ADR-018 a citizen could authenticate and SEE their applications, but
could not ACT: withdrawing an application required waiting for a terminal
state, and demanding erasure required physically reaching an officer
(erasure-sop step 1). Both gaps were flagged follow-ons (ADR-017 #1,
ADR-018 #6). The erasure SOP even had to tell refused citizens "the
withdrawal channel is not yet built."

## Decisions

### Voluntary withdrawal — a system-token write carrying the citizen's own authority

`POST /v1/applicants/me/applications/withdraw` (session-authenticated,
identity-service) → `POST /v1/applications/withdraw-own` (kind:'system',
application-service, the single writer per ADR-006). The portal backend
asks on the citizen's behalf with its ADR-016 client-credentials token;
the applicantId is **session-derived truth**, never a body claim about
someone else.

- **Ownership is the row lookup**: `WHERE id = X AND applicant_id = Y FOR
  UPDATE` in the same transaction — a mismatch on either column is the same
  `404 NOT_FOUND`. The door is deliberately not an ownership oracle.
- **Attribution**: history `performed_by = 'APPLICANT'` (a citizen act —
  not SYSTEM, not an officer); audit `APPLICATION_WITHDRAWN` with
  `cause: 'APPLICANT_REQUEST'`, performedBy the applicant's opaque UUID.
- **Terminal discipline**: already-WITHDRAWN → idempotent `200 NO_CHANGE`
  (no writes, no audit); ACCEPTED / REJECTED / WALK_IN_REJECTED →
  `409 NOT_APPLICABLE`. `status::text` comparisons (rnp/rcs enums lack
  WALK_IN_*, the ADR-017 idiom).
- Officer tokens are refused (403): an officer withdrawing on a citizen's
  behalf would be an unaudited impersonation path.

### Erasure request intake — a DPO queue, not direct execution (owner D10)

The owner chose **request-intake** over citizen-triggered execution: the
tombstone is irreversible and an OTP session (phone possession + NID
knowledge) is weaker authentication than an officer's accountable act.
Direct execution can be revisited when stronger citizen auth exists.

- `public_core.erasure_requests` (**rls/0017**): PII-free rows
  (opaque UUIDs, status PENDING/EXECUTED/DECLINED, timestamps, bounded
  note) that **survive the erasure they ask for** — the demand's existence
  is the controller's accountability record, like audit rows. One live
  PENDING per citizen (partial unique index); an all-or-nothing decision
  CHECK (PENDING rows carry no decision fields, decided rows carry both).
  System-role-scoped with FORCE RLS (the 0016 posture).
- Citizen: `POST/GET /v1/applicants/me/erasure-request` (session-auth).
  Filing is idempotent and audited once (`ERASURE_REQUESTED`); re-filing
  returns the live request. After a decline the citizen may re-file.
- Officer/DPO: `GET /v1/identities/erasure-requests` (the PENDING queue)
  and `POST .../decline` with a mandatory ground (audited,
  `ERASURE_REQUEST_DECLINED`). **Execution has no new route** — it IS the
  existing ADR-015 road, whose gate mechanics are untouched; an executed
  erasure best-effort stamps the pending request `EXECUTED` with the
  accountable officer's UUID (a missed stamp leaves a PENDING row a DPO
  finds already-erased — never the reverse).
- The two acts compose: a citizen refused erasure for a live application
  can now withdraw it themselves and the gate opens (proven end-to-end,
  gate #34).

### Drizzle mirroring — deliberately NOT (migration hygiene)

`erasure_requests` follows the 0016 precedent (hand-run rls/ DDL, no
drizzle schema mirror). **Warning recorded for the contact-capture
slice**: `field_devices` (rls/0009) IS mirrored in
`public-core.schema.ts` while absent from the drizzle 0000 snapshot — the
first real `drizzle-kit generate` will try to re-create it (and anything
else mirrored-but-hand-migrated). That reconciliation is part of the
contact slice's cold-run validation, not this one.

## Consequences

- 18/19 statuses reachable, WITHDRAWN now with both writers (automatic
  ADR-017 + voluntary). DRAFT remains the deliberate exception.
- The erasure SOP's intake step is real: demands are timestamped and
  queryable the moment they are made, refusals carry recorded grounds.
- Branch protection (owner D11: required checks on main, ff-flow kept) is
  **BLOCKED by GitHub plan** — free-tier private repos cannot enforce
  protection; documented for the owner (Pro upgrade or org move).

## Follow-ons (flagged, not built)

1. Rate limiting on citizen routes (shared with ADR-018 #1).
2. Cooling-off auto-execution variant of D10 (needs a scheduled executor).
3. DPO as a distinct role/scope — today any officer decides the queue.
4. Statutory response deadline surfaced on the queue (legal TBD in SOP).
5. Notification to the citizen on decline/execution (needs contact capture).
