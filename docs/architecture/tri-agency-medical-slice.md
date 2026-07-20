# Tri-Agency Medical Slice — Certificate Mode for RNP/RCS (ADR-013)

**Landed:** 2026-07-19 · commits `3fed138` (rls/0012) · `30235a8`
(certificate mode) · `0dbcd3d` (proof) · gate 28/28 green on the final
proof run · `pnpm -r build` clean.

## What changed

Before this slice, `POST /v1/applications/medical-review` served RDF only;
RNP/RCS officers got 501 `UNSUPPORTED_AGENCY` and their applications
dead-ended at `PHYSICAL_TEST_COMPLETE`. Now all three agencies travel the
full funnel tail — `PHYSICAL_TEST_COMPLETE → MEDICAL_REVIEW →
FINAL_SHORTLIST → ACCEPTED` — proven end-to-end live.

The design rationale, evidence, and owner decisions (D1: RNP mirrors RCS;
D2: physician name required on CERT_VERIFIED) live in
[ADR-013](adrs/ADR-013-tri-agency-medical-modelling.md). This doc records
the mechanics.

## The two modes

Mode is derived from the **verified token's agency** — never the body.

| | BOARD (RDF) | CERTIFICATE (RNP, RCS) |
|---|---|---|
| Body | `fitnessStatus: FIT\|UNFIT` | `certVerdict: CERT_VERIFIED\|CERT_REJECTED` (+ `physicianName` iff verified, ≤200) |
| Positive | → `MEDICAL_REVIEW`; stamps `medical_reviewed_by_id/_at` + `medical_fitness_status` | → `MEDICAL_REVIEW`; stamps `medical_cert_verified/_verified_at/_physician_name` |
| Negative | → `REJECTED` (same stamps) | → `REJECTED`; cert columns **untouched** — `verified=false` keeps meaning "never verified"; history row is the record |
| Wrong-mode body | 422 `INVALID_MEDICAL_INPUT` | 422 `INVALID_MEDICAL_INPUT` |

Everything else is Slice-4 machinery unchanged: officer DB role transaction,
`FOR UPDATE` → pure `decide()`, idempotent NO_CHANGE, hold-safe 409,
cross-agency 404, walk-in lane merge (`WALK_IN_PHYSICAL_TEST` accepted as a
from-status; walk-ins are structurally RDF-only so they always take BOARD).

## Layer map

- **shared-database** — `rls/0012_rnp_medical_cert_columns.sql` (idempotent,
  parity-proven vs rcs_ops), mirrored in `rnp-ops.schema.ts`, bootstrap
  step 13.
- **application-service**
  - `ports/officer-transition-repository.ts` — `MedicalReviewInput` is now a
    union discriminated on `mode` (`BOARD` | `CERTIFICATE`).
  - `adapters/officer-transition.pg-repository.ts` — mode picks the UPDATE
    column set; shared transaction skeleton.
  - `application/officer-transitions.service.ts` — mode derivation from the
    principal, input validation (physician-name rules), audit metadata
    carries `mode` + verdict only.
  - `adapters/http/officer-transitions.controller.ts` — body-shape
    validation for both modes; outcome map: 501 → 422.

## Privacy

The physician name is stored in the DB column and appears **nowhere else**:
not on the event bus, not in any HTTP response. Asserted in the proof.

## Proof (scenario 9, `verify-officer-lifecycle-slice.ts`)

Input guards before any write (2 × 422, row untouched) · RNP full lane to
ACCEPTED as the RNP officer role with 0012 columns stamped · RCS full lane
+ idempotent re-apply · CERT_REJECTED → REJECTED with columns honestly
untouched · per-schema history accounting, `performed_by` = officer UUID ·
physician name absent from bus + responses · no PII in responses.

## Deferred / follow-ons (flagged, not blocking)

- `medical_cert_verified_by_id` on both cert schemas if per-column officer
  attribution is ever required (today: history `performed_by`).
- Certificate upload + forensics-lane integration (needs the portal/upload
  slice).
- Tri-agency walk-in (walk-in stays RDF-only per ADR-012).
