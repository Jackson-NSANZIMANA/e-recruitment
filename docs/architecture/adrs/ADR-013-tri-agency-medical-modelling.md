# ADR-013 — Tri-Agency Medical Modelling: BOARD vs CERTIFICATE Modes

**Status:** Accepted (owner-signed 2026-07-19)
**Supersedes:** the Slice-4 `UNSUPPORTED_AGENCY` 501 stopgap on medical review
**Related:** ADR-006 (single writer), ADR-011 (adjudication), ADR-012 (walk-in lane merge), rls/0012

## Context

Slice 4 shipped officer medical review for RDF only. The three agencies
genuinely model medical review differently (verified live 2026-07-12):

| Schema | Columns | Real-world process |
|---|---|---|
| `rdf_ops` | `medical_reviewed_by_id/_at`, `medical_fitness_status` | In-house medical **board** records a fitness verdict |
| `rcs_ops` | `medical_cert_verified/_verified_at/_physician_name` | Officer verifies a government-physician **certificate** |
| `rnp_ops` | *(none)* | — |

Rather than guess, Slice 4 returned a clean 501 for RNP/RCS and flagged the
modelling as an owner/agency decision. Consequence: RNP and RCS applications
dead-ended at `PHYSICAL_TEST_COMPLETE` — the funnel was single-agency past
the physical test.

### Evidence from the recruitment announcements (vision archive)

- **RNP** (CADET_OFFICER): applicants bring a *"Medical certificate approved
  by a recognized government doctor."*
- **RCS** (all categories): *"Medical certificate issued by an authorized
  Government physician"* — alongside celibacy/birth certificates.
- **RDF**: no brought-certificate requirement; medical fitness is assessed
  in-house (the board model Slice 4 implemented).

So the real world has **two modes, not three**: RDF assesses; RNP and RCS
verify a brought document.

## Decision

**D1 — RNP mirrors the RCS certificate model byte-for-byte** (owner, 2026-07-19).
`rls/0012` adds `medical_cert_verified` (boolean default false),
`medical_cert_verified_at` (timestamptz), `medical_cert_physician_name`
(varchar 200) to `rnp_ops.applications`, proven IDENTICAL to rcs_ops via
information_schema parity check. No enum migration (`MEDICAL_REVIEW` /
`FINAL_SHORTLIST` already exist in all three enums); no new grants (0001's
table-level GRANTs cover the writers).

**D2 — CERT_VERIFIED requires the physician name** (owner, 2026-07-19).
Non-empty, ≤200 chars. The announcements hinge on *who* signed —
"recognized government doctor" — so recording the signer is the audit
substance, not an optional nicety. `CERT_REJECTED` takes no name.

**Mechanics.** `medicalReview` is one transition with two modes, the mode
derived from the **verified principal's agency**, never the request body:

- **BOARD (RDF)** — `fitnessStatus: FIT|UNFIT`; unchanged Slice-4 semantics.
- **CERTIFICATE (RNP/RCS)** — `certVerdict: CERT_VERIFIED|CERT_REJECTED`
  (+ `physicianName` iff verified). Verified → `MEDICAL_REVIEW` + stamps the
  three cert columns. Rejected → `REJECTED` with cert columns **untouched**:
  `medical_cert_verified=false` keeps meaning "never verified" (not
  "verified false at time T"); the REJECTED status + append-only history row
  (performed_by = officer UUID) are the record of the decision.

Body/mode mismatch → **422 `INVALID_MEDICAL_INPUT`** with a reason naming the
agency's mode. This *replaces* the 501 in the officer-transition outcome map
(walk-in's own RDF-only 501 is separate and untouched). The transaction
skeleton is unchanged: `SET LOCAL ROLE usrp_<agency>_officer` → `FOR UPDATE`
→ pure `decide()` → UPDATE + history append. `requiredFrom` stays
`[PHYSICAL_TEST_COMPLETE, WALK_IN_PHYSICAL_TEST]` — walk-in rows can never
be certificate-mode (rnp/rcs lack the WALK_IN_* enum values; DB-guaranteed).

**Privacy boundary.** The physician name reaches the DB column and nowhere
else — not the audit stream (audit metadata carries mode + verdict only),
not any HTTP response. Proven by assertion.

## Alternatives rejected

- **Unify all three agencies on one medical model** — erases RDF's genuinely
  different in-house-board process and rewrites working, proven Slice-4
  code for uniformity's sake. The divergence is real; the model should say so.
- **A bespoke RNP model** — no evidence RNP differs from RCS's certificate
  flow; would be invention, not modelling.
- **Route certificate verification through document-forensics** — the cert
  is brought physically on paper per the announcements; scanning/upload
  belongs to the (deferred) portal/upload slice. Flagged follow-on: when
  uploads exist, cert documents can join the forensics lane.

## Consequences

- All three agencies now travel `PHYSICAL_TEST_COMPLETE → MEDICAL_REVIEW →
  FINAL_SHORTLIST → ACCEPTED`; proven e2e live for RNP and RCS (officer
  DB-role writes, cross-agency isolation intact).
- The cert columns have no `*_by_id` (RCS parity — the pre-existing RCS
  block never had one). The verifying officer is recoverable from history
  `performed_by`. **Follow-on candidate:** add `medical_cert_verified_by_id`
  to both schemas if per-column attribution is ever required by audit.
- The future cross-agency accept-lock (runway #2) now covers all three
  agencies' accept paths for free — they share the single funnel tail.
