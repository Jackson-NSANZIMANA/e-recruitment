# ADR-014 — Cross-Agency Accept-Lock: One Citizen, One Acceptance

**Status:** Accepted (owner-signed 2026-07-26)
**Related:** ADR-002 (schema isolation), ADR-006 (single writer), ADR-013 (tri-agency medical), rls/0013

## Context

A citizen may lawfully apply to RDF, RNP, and RCS in the same season — the
platform models this as one shared identity row
(`public_core.applicant_identities`, `national_id_hash` UNIQUE) with
independent applications in each agency's isolated ops schema. Every stage of
the funnel tolerates that multiplicity: a person may sit three exams, pass
three physical tests, even be FINAL_SHORTLISTed by two agencies at once.

The positive terminal does not. A person cannot simultaneously enlist in the
army, the police, and the correctional service. Yet before this slice nothing
prevented two agencies from both driving the same citizen to ACCEPTED — the
schema had carried lock columns (`cross_agency_locked_at`,
`cross_agency_locked_by_agency`, `cross_agency_lock_reason`) since baseline
0000 with **zero writers** (verified by grep across the codebase,
2026-07-26). Cross-agency isolation (charter invariant #1) was fully enforced
for *reads and writes within* an agency, but its platform-wide corollary —
one acceptance per citizen — was aspiration, not mechanism.

This was the last invariant-critical gap in the backend backbone; the owner
chose to close it ahead of compliance docs and delivery-integrity work
("Accept-lock now", 2026-07-26).

## Decision

**D1 — Lock fires at ACCEPT only** (owner, 2026-07-26). FINAL_SHORTLIST never
contends: being shortlisted by two agencies is a legitimate, real-world state.
Only the officer accept endpoint stamps the lock.

**D2 — Block-only; withdrawal deferred** (owner, 2026-07-26). When agency A
accepts, the citizen's in-flight applications at agencies B/C stay exactly
where they are — dormant, not withdrawn. Any later accept attempt by another
agency (or the same agency via a second application) is refused with **409
`CROSS_AGENCY_LOCKED`** naming the holding agency. Event-driven
auto-withdrawal (a first-WITHDRAWN-writer consuming an acceptance event) is a
flagged follow-on slice, not this one — it introduces a new writer per ops
schema and deserves its own sign-off.

**D3 — Compare-and-set on the shared identity row, as the officer's own DB
role.** Inside the existing accept transaction (`SET LOCAL ROLE
usrp_<agency>_officer`), after the status guard passes:

```sql
SELECT cross_agency_locked_by_agency
FROM public_core.applicant_identities
WHERE id = $applicant FOR UPDATE;          -- serializes ALL agencies here

-- holder present → return CROSS_AGENCY_LOCKED, tx rolls back untouched

UPDATE public_core.applicant_identities SET
  cross_agency_locked_at        = now(),
  cross_agency_locked_by_agency = $agency,
  cross_agency_lock_reason      = 'ACCEPTED'
WHERE id = $applicant AND cross_agency_locked_at IS NULL;
```

Why this shape:

- **Bilateral exclusion from a unilateral stamp.** The identity row is unique
  per citizen, so whoever stamps first wins and every later accept — any
  agency — sees the holder and refuses. No coordination channel between
  agencies is needed; the shared row *is* the channel.
- **Race-safe without advisory locks.** Concurrent accepts from different
  agencies touch different application rows (different schemas) but the SAME
  identity row; `FOR UPDATE` serializes them there. Lock ordering is
  app-row → identity-row everywhere, and the identity row is the single
  shared contention point, so deadlock is impossible.
- **No privilege escalation.** rls/0001 already grants officer roles SELECT,
  UPDATE on `applicant_identities`, and the `pc_ai_<agency>` RLS policy
  (EXISTS an application in the officer's own ops schema) exposes exactly the
  citizens the officer could be accepting. The accepting case is always
  inside the policy — no `system_service` hop, keeping the accept transaction
  a single-role story.
- **Status guard precedes the lock check**, so the holder's idempotent
  re-accept still returns `NO_CHANGE` and never re-reads the lock.
- **Blocked accepts write nothing and audit nothing** — the transaction
  returns before any mutation; the 409 body carries only
  `{ status, lockedByAgency }` (agency code, no PII).

**D4 — Engine backstop is a CHECK constraint, not a unique index**
(deviation from the approved plan, documented in rls/0013's header). The plan
specified a partial unique index on the lock columns; during implementation
this was recognized as vacuous — the identity row is already unique per
citizen, so a unique index over its lock columns can never fire. What the
engine *can* usefully refuse is a partially-stamped lock. rls/0013 therefore
adds `ck_pc_ai_lock_all_or_nothing`: all three lock columns are set together,
or none. Applied idempotently (proven twice live); probe-tested both
directions (half-stamp → CHECK violation; full stamp → accepted), both under
rollback.

## Consequences

- One citizen reaches ACCEPTED at most once, platform-wide, enforced inside
  the accept transaction and proven live — including a raced concurrent
  accept from two agencies where exactly one wins
  (`verify-officer-lifecycle-slice.ts` §10).
- Losing applications sit at FINAL_SHORTLIST indefinitely (D2). Officers see
  a truthful 409 naming the holder if they try to accept; nothing advances or
  withdraws automatically. Acceptable for now; the withdrawal slice retires
  this.
- The lock is permanent in this slice — there is no unlock path. A citizen
  who declines enlistment or is discharged cannot yet be re-accepted anywhere.
  Unlock/appeal is an accountable-officer workflow requiring owner/agency
  sign-off (follow-on, flagged).
- `cross_agency_lock_reason` is stamped `'ACCEPTED'` uniformly; the vocabulary
  is open for future reasons (e.g. sanctions, fraud hold) without schema
  change.

## Follow-ons (flagged, not in this slice)

1. **Event-driven auto-withdrawal** — first WITHDRAWN writer per ops schema
   consuming the acceptance; needs its own ADR and sign-off (D2).
2. **Unlock / appeal workflow** — accountable-officer action with audit trail.
3. **`accepted_by_id` / `accepted_at` stamp gap** — the applications tables
   carry no acceptance attribution columns (unlike medical/final stages);
   history rows carry `performed_by`, but a first-class stamp would mirror
   the other stages.
