# ADR-051 — Resolving a vetting hold: the human verb for a held application

**Status:** Accepted · 2026-11-01 (defect-closure session D0) · closes evaluation 2026-10-29 defect **D10**
**Deciders:** platform owner (2026-11-01, §2) · engineering for §3
**Relates to:** ADR-011 amber lane and late disqualification, ADR-006 single writer, ADR-012 walk-in lane, ADR-021 read models, ADR-031 operation permissions and separation of duties, ADR-048 identity binding, ADR-049 campaign policy, ADR-050 re-drive
**Migration:** none (writes existing columns in all three schemas)

## 1. Context

The amber queue is an honest read of a dishonest state.

`listAmberQueue` surfaces, by design, every application held on evidence a human must judge:

- `status ∈ {DOCUMENT_REVIEW_AMBER, ADJUDICATION_REVIEW}` — **has a verb**: `POST /v1/applications/adjudicate`;
- `criminal_clearance_status = 'UNDER_REVIEW'` at any non-terminal status — **no verb**;
- `academic_status = 'PENDING'` with `failureCode = 'NESA_REVIEW_REQUIRED'` — **no verb**.

`adjudicate` accepts only `ADJUDICABLE = {DOCUMENT_REVIEW_AMBER, ADJUDICATION_REVIEW}`. A row held on a criminal review sits at `CRIMINAL_CLEARANCE` (a *lower* rank), so the one officer operation that looks applicable answers **`409 NOT_APPLICABLE`**. The queue therefore shows work the console cannot do — with the reason codes rendered correctly, which makes it worse, not better.

The hold itself is correct: ADR-011 says a criminal `UNDER_REVIEW` is a **hold, not a fail**, and ADR-048 says a partial name match routes to a human. What is missing is the exit.

## 2. Owner decisions (2026-11-01)

| Decision | Taken |
|---|---|
| Is a human resolution in scope at all | **Yes.** A hold with no verb is a permanent trap for the citizen and a lie to the operator. |
| One endpoint or one per dimension | **One**, with `dimension` in the body (`CRIMINAL` \| `ACADEMIC`), so a future dimension (biometric, ADR-037) does not need a new path. |
| Separation of duties | **On by default**: the officer who resolves a criminal hold may not be the officer who accepts that application (`CLEARANCE_REVIEW_EXCLUDES_ACCEPTER`, config-gated per agency). |
| Permission | Grant `vetting.hold.resolve` to the existing `adjudicator` role. No new role in phase 0. |
| NESA review | **In scope.** Leaving half the queue verbless would be a half-fix of one class. |

## 3. Decision

### 3.1 One operation

```
POST /v1/applications/vetting-hold            (officer, permission vetting.hold.resolve, CSRF, no retry)

{ applicationId, dimension: 'CRIMINAL' | 'ACADEMIC', decision, reasonCode, notes? }

CRIMINAL: decision ∈ { CLEAR, CONFIRM }
  CLEAR   → criminal_clearance_status = 'CLEARED'
  CONFIRM → criminal_clearance_status = 'FLAGGED_CONVICTION'
ACADEMIC: decision ∈ { ACCEPT, REJECT }
  ACCEPT  → academic_status = 'ELIGIBLE'
  REJECT  → academic_status = 'INELIGIBLE'  (+ detail with the closed reason)
```

`reasonCode` is drawn from a closed set (the queue's own vocabulary, extended with the officer's grounds). It is stored on the history row and the audit entry; it never reaches a citizen response unfiltered.

### 3.2 The status is derived, never hand-set

The transaction, under `FOR UPDATE` and the officer's DB role:

1. loads the row's three evidence verdicts;
2. asserts the dimension is genuinely **held** (`UNDER_REVIEW`, or `PENDING` + `NESA_REVIEW_REQUIRED`) — otherwise `409 NOT_APPLICABLE`. This is what stops the endpoint becoming a general "set any clearance" back door;
3. writes the evidence column;
4. calls the **existing pure** `deriveApplicationStatus(current, evidence)` to obtain the next status;
5. writes status + `application_status_history` in the same transaction.

Step 4 is the decision. The early-vs-late rule (`REJECTED` before `SLOT_ASSIGNED`, `ADJUDICATION_REVIEW` at or after it), the walk-in geography and the monotonic max-rank all behave exactly as they do for registry evidence, because it is literally the same function. A second state machine here would be a second source of truth, and ADR-011 exists because of what that costs.

When the derivation lands on `DOCUMENT_REVIEW_GREEN`, the use case re-emits `APPLICATION_ELIGIBILITY_CLEARED` — the same reconvergence path `adjudicate` already takes (owner decision D4): one path into the slot lane, and scheduling-service is none the wiser.

### 3.3 Evidence the officer acted on is preserved

`clearance_certificate_verifications` is append-only and is **not** modified. The officer's decision is a *new* fact: an `AUDIT_ENTRY` `VETTING_HOLD_RESOLVED` carrying dimension, decision, reason code, the closed prior evidence values, the reviewer's officer id and the correlation id — no names, no registry payload, no national ID. The reviewer can always be asked later *what* they cleared and *why*; the citizen can always be shown that a human decided.

### 3.4 Separation of duties

A new rule id, checked where `ACCEPT_EXCLUDES_FINAL_DECIDER` is already checked (the accept transaction, `SeparationOfDutiesConfig`): if the officer who accepts the application is the officer who resolved its criminal hold, the accept answers `403 SEPARATION_OF_DUTIES` with the rule id — never naming who performed the earlier step. Config-gated; **ON** by default; an agency may relax it explicitly.

This is the highest-stakes decision in the system: a human overriding a registry signal about a citizen's criminal record. Four eyes on it is the national-grade answer, and the platform already has the mechanism.

### 3.5 The queue tells the console which verb applies

The amber-queue read returns `dimension` alongside its existing `reasons`, so the console renders one action per row instead of guessing. Response shape stays an allowlist; nothing new is exposed beyond the closed dimension and reason codes.

### 3.6 The class-killer: no visible hold without a verb

A new zero-infrastructure proof, `verify-hold-coverage.ts`, holds a table of `(queueReason → resolving operationId)` and asserts:

1. **exhaustive against the producer**: every reason `queueReasons()` can emit has an entry;
2. **exhaustive against the registry**: every named operation exists in `EDGE_OPERATIONS` and is mounted;
3. **no orphan verbs**: every operation in the table is reachable by the permission it names.

A new queue reason with no resolving operation now fails the gate at the very front of CI, next to the contract-drift proof. This is what makes the D10 class unrepeatable instead of merely fixed.

## 4. Rejected alternatives

| Alternative | Why not |
|---|---|
| **Widen `ADJUDICABLE` to include `CRIMINAL_CLEARANCE` and reuse `adjudicate`** | `adjudicate` deliberately manipulates the *document* and *late-flag* holds, and its CLEAR branch restores a recorded prior status. A clearance review is a different act — it rewrites **evidence**, and its result must be re-derived. Reusing the path would give one operation two meanings and one audit action two natures. |
| **Let the officer set the top-level status directly** | A generic status write. The repository's invariant "no generic status PATCH" exists because that is how state machines die. |
| **Have the re-driver (ADR-050) resolve the hold automatically** | Re-drive is for *transient* faults, and it must never invent a business verdict. A parked case is precisely the one where a human must look. |
| **A new `vetting_officer` role** | Adds a role, a grant matrix and a UI surface to phase 0 for no proven need. `adjudicator` already exists and already means "decides a hold". |
| **Expose the registry payload to the reviewer** | ADR-048 §2.3: whatever the reviewer needs is a closed verdict and the reason, not a copy of a citizen's record. |

## 5. Consequences

- The amber queue becomes actionable end to end: every row has an operation, a permission and an audit record.
- An officer can now, by design, clear a criminal hold. That is the intended authority (ADR-048 known gap 1 named it), and §3.3–3.4 make it reviewable and double-checked.
- `ACCEPT_EXCLUDES_FINAL_DECIDER` (S06) and `CLEARANCE_REVIEW_EXCLUDES_ACCEPTER` are two rules of one shape; a third is plausible (medical). The config shape must stay a list of rule ids, not booleans with names.
- The frontend consumes a new operation. Hand-off required (operation id, states, closed codes, the SoD refusal, the permission) — the console screen itself is `e-recruitment-ui`.

## 6. Not decided here

- Whether the citizen receives a notice on resolution (S10a owns notices).
- Whether a resolved-then-accepted application needs a countersignature in the pilot (S18 procedure).
- The full appeals workflow after `CONFIRM` (legal, `ROADMAP.md` §6 item 6).
