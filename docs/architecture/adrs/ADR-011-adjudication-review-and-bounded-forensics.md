# ADR-011 — ADJUDICATION_REVIEW status & the bounded-real forensics tier

**Status:** Accepted (owner-signed, 2026-07-14/15) · **Slice:** amber lane (Slice 5)

## Context

Two long-parked decisions blocked the amber lane:

1. **Late disqualification.** `deriveApplicationStatus`'s hard-fail branch
   auto-REJECTED on a disqualifying verdict arriving AFTER the eligibility
   terminal (e.g. a late criminal flag on a SLOT_ASSIGNED row) — a cleared,
   scheduled applicant removed off the backbone with no human in the loop.
   The 2026-07-09 decision deliberately kept that default and parked the
   alternative; this slice built the adjudication surface that makes the
   alternative implementable.
2. **Forensics depth.** `DOCUMENT_REVIEW_AMBER`, `document_records`, and the
   `ForensicsFlags`/`DocumentLane` contracts were modeled but had zero runtime
   writers. How real must the analyzer be to ship the lane?

## Decision 1 — late disqualification routes to a NEW `ADJUDICATION_REVIEW` status

- A hard fail **before** `SLOT_ASSIGNED` keeps the autonomous fail-closed
  `REJECTED` (unchanged). A hard fail **at/past** `SLOT_ASSIGNED` routes to
  `ADJUDICATION_REVIEW` — a human-adjudication hold, exited only by the
  officer adjudicate endpoint (CLEAR restores the pre-flag stage from the
  append-only history; REJECT rejects).
- The same late-vs-early policy applies to adverse **document forensics**
  verdicts (RED/AMBER lanes) — one uniform rule for any post-clearance
  adverse signal.
- `ADJUDICATION_REVIEW` is deliberately **separate from `DOCUMENT_REVIEW_AMBER`**:
  amber is routine document review; adjudication is a post-clearance security
  hold — distinct authority and audit semantics. Reusing amber would have
  mixed the two queues (rejected option).
- Enum position: between `ACCEPTED` and `REJECTED` (migration 0011,
  `BEFORE 'REJECTED'` on all 3 ops schemas) so its canonical rank exceeds
  every in-flight stage — the monotonic max-rank guard holds the row against
  redelivered evidence.
- Known nuance (documented, accepted): a CLEAR from `ADJUDICATION_REVIEW`
  restores the stage but the adverse G2G evidence column keeps its value, so
  a redelivered stale vetting event can re-hold; the officer re-clears. A
  "dismissed-flag" marker is a follow-on if it bites in practice.

## Decision 2 — the analyzer ships REAL-BOUNDED and ZERO-DEP; invariant #5 stands

Owner initially leaned toward the full forensics program (heavy CV/ML deps,
amending invariant #5); on architectural counsel this was REVERSED: a forgery
detector's hard part is **proving accuracy**, and without a labeled forgery
corpus we cannot green-gate ELA/anti-GAN/OCR claims — shipping them now would
assert an unvalidated capability (false confidence, worse than none, in a
national-security context).

- **This slice ships real signals, provable today:** a genuine ClamAV verdict
  (hand-rolled clamd INSTREAM over `node:net`), real byte-level container
  identification + metadata-presence parsing (JPEG segment walk, PNG chunk
  walk, PDF probes), and C2PA-manifest **presence** detection — composed by a
  deterministic pure `composeVerdict` into score + lane. MinIO retrieval is a
  hand-rolled AWS SigV4 GET (`node:http`/`node:crypto`), retrieval-only.
  **Zero new npm dependencies; invariant #5 intact, no amendment.**
- **The perceptual tier is a deferred PROGRAM** (ELA re-encode analysis,
  anti-GAN DCT, OCR font/stamp-clone): its own future ADR **plus a validation
  plan** — a labeled forgery corpus and explicit FP/FN targets — before any
  verdict from it is trusted. It slots in behind the same `ForensicsAnalyzer`
  port; nothing else changes.
- **Contract honesty:** `ForensicsFlags`' four perceptual checks are
  `boolean | null`, null = "not analyzed". A hard `false` would assert
  "checked and clean" — prove-it-don't-assert-it applies to data shapes too.

## Decision 3 — reconvergence reuses `application.cleared` (no new path)

An officer CLEAR on an amber hold **re-derives** the status from the row's
vetting evidence via the same pure lifecycle (baseline `SUBMITTED`): all-pass
→ `DOCUMENT_REVIEW_GREEN` and the service re-emits `application.cleared`, so
amber-cleared and green-cleared applicants travel ONE slot lane
(scheduling-service unchanged, unaware). Evidence still pending → the furthest
justified vetting stage — a human clear can never leapfrog an unanswered
criminal check.

## Consequences

- 13 of 18 statuses now reachable (+`DOCUMENT_REVIEW_AMBER`, +`ADJUDICATION_REVIEW`).
- 4th real supporting service (document-forensics-service); gate 25 → 27.
- Upload/portal, virus-scan-on-upload, MinIO byte WRITES, and the perceptual
  tier remain explicitly deferred.
