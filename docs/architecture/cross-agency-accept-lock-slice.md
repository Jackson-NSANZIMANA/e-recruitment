# Cross-Agency Accept-Lock Slice — One Citizen, One Acceptance (ADR-014)

**Landed:** 2026-07-26 · migration `rls/0013` · lock in the officer accept
transaction · proof §10 in `verify-officer-lifecycle-slice.ts` · green ≥2×
re-runnable. (Commit hashes + final-gate result recorded at slice-final
commit per D0 cadence.)

## What changed

Before this slice, nothing stopped two agencies from both driving the same
citizen to `ACCEPTED` — the lock columns on
`public_core.applicant_identities` had existed since baseline 0000 with zero
writers. Now the officer accept transaction stamps a platform-wide accept-lock
on the citizen's shared identity row, and any later accept of that citizen —
by any agency — is refused with **409 `CROSS_AGENCY_LOCKED`** naming the
holder, writing nothing.

Design rationale and owner decisions (D1: lock at ACCEPT only; D2: block-only,
withdrawal deferred; D3: compare-and-set as the officer's own role; D4: CHECK
backstop instead of the planned unique index) live in
[ADR-014](adrs/ADR-014-cross-agency-accept-lock.md). This doc records the
mechanics.

## The transaction (accept, after this slice)

All inside one `sql.begin`, as `usrp_<agency>_officer` (`SET LOCAL ROLE`):

1. `SELECT status, applicant_id FROM <ops>.applications WHERE id = $app FOR UPDATE`
2. Pure `decide()` guard — `NO_CHANGE` / `NOT_APPLICABLE` / `NOT_FOUND`
   return here, **before** the lock is ever read (so the holder's idempotent
   re-accept is still `NO_CHANGE`).
3. `SELECT cross_agency_locked_by_agency FROM public_core.applicant_identities
   WHERE id = $applicant FOR UPDATE` — the platform-wide serialization point.
   Holder present → return `CROSS_AGENCY_LOCKED { lockedByAgency }`; tx rolls
   back with zero writes, zero audit.
4. Stamp the lock: `UPDATE … SET cross_agency_locked_at = now(),
   …_by_agency = $agency, …_reason = 'ACCEPTED' WHERE id = $applicant AND
   cross_agency_locked_at IS NULL` — with a fail-closed guard if the update
   reports ≠ 1 row (unreachable under the FOR UPDATE, kept anyway).
5. Pre-existing: `UPDATE … SET status = 'ACCEPTED'` + append status-history.

Race-safety: concurrent accepts from different agencies hold different
application-row locks (different schemas) but contend on the **same** identity
row at step 3. Lock order is app-row → identity-row everywhere; the identity
row is the only shared object → no deadlock.

Privileges: rls/0001 already grants officers SELECT, UPDATE on
`applicant_identities`; policy `pc_ai_<agency>` (EXISTS application in own ops
schema) covers exactly the accepting case. No `system_service` escalation.

## HTTP surface

| Outcome | Status | Body |
|---|---|---|
| `CROSS_AGENCY_LOCKED` | 409 | `{ "status": "CROSS_AGENCY_LOCKED", "lockedByAgency": "RDF" \| "RNP" \| "RCS" }` |

`lockedByAgency` may be a sibling agency **or the caller's own** (citizen
accepted via a second application in the same agency). No PII — status +
agency code only. Blocked attempts emit no `AUDIT_ENTRY` (the service's
`#audit()` only fires on `APPLIED`; a PII-free blocked-attempt audit was
considered and deferred with the withdrawal follow-on, where refusals become
observable events).

## Migration rls/0013

Adds `ck_pc_ai_lock_all_or_nothing`: the three lock columns are all set or
all NULL — a half-stamped lock is an app-logic bug the engine refuses to
store. **Deviation from plan** (documented in the file header): the planned
partial unique index was vacuous (identity row already unique per citizen)
and was replaced by this CHECK. Idempotent (applied twice live); probed both
directions under rollback. Wired as step 14 of `scripts/bootstrap-db.sh`.

## Proof (§10, `verify-officer-lifecycle-slice.ts`)

Seeds four citizens (one per ACCEPTED lane — the lock itself forces this
test-data shape) and proves, over real TCP against live RLS:

- every accept in §§1–9 stamped the lock with the accepting agency;
- RNP accept of the RDF-accepted citizen (legitimately FINAL_SHORTLISTed) →
  409 naming RDF, app untouched, **no history row, no audit event**;
- holder re-accept → `NO_CHANGE` (status guard precedes lock);
- **raced concurrent accepts** (RNP + RCS, same citizen, `Promise.all`) →
  exactly one `APPLIED`, one `CROSS_AGENCY_LOCKED`, lock names the winner,
  loser still `FINAL_SHORTLIST`;
- no `national_id_hash` in any lock response;
- cleanup deletes the seeded identities (clearing their locks) — re-runnable,
  proven green twice consecutively.

## Not in this slice (flagged in ADR-014)

Event-driven auto-withdrawal of losing applications · unlock/appeal workflow
· `accepted_by_id/_at` attribution columns.
