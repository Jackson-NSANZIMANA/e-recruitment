# Amber Lane Slice — document forensics + human adjudication (Slice 5)

**Landed 2026-07-15 · gate 25 → 27 green · ADR-011.** Makes
`DOCUMENT_REVIEW_AMBER` and the new `ADJUDICATION_REVIEW` reachable +
adjudicable, and stands up `document-forensics-service` (4th real supporting
service) — the amber machinery was modeled-but-dead since the baseline schema.

## Shape

```
            POST /v1/forensics/analyze (system token; reference: app+agency+type+objectKey)
                       │
        document-forensics-service
        MinIO GET (hand-rolled SigV4) → real bytes
        ├─ ClamAV clamd INSTREAM (node:net)          — REAL virus verdict
        ├─ container/metadata byte probe              — REAL (JPEG/PNG/PDF)
        ├─ C2PA JUMBF presence                        — REAL (presence ≠ validity)
        └─ pure composeVerdict → lane/score/flags     — deterministic
                       │ writes <agency>.document_records (first writer)
                       ▼ emits document.forensics + AUDIT_ENTRY
        application-service  (group: application-service-forensics)
        applyForensicsRouting:
          RED   pre-slot → REJECTED   · at/past slot → ADJUDICATION_REVIEW
          AMBER pre-slot → DOCUMENT_REVIEW_AMBER hold · post-slot → ADJUDICATION_REVIEW
          GREEN → status never moves
                       │
        GET  /v1/applications/amber-queue   (officer; non-PII queue w/ forensic signals)
        POST /v1/applications/adjudicate    (officer; CLEAR | REJECT, officer DB role)
          CLEAR@AMBER  → re-derive from vetting evidence (pure lifecycle):
                         all-pass → DOCUMENT_REVIEW_GREEN → emits application.cleared
                         → scheduling → SLOT_ASSIGNED  (same lane as green-cleared)
                         pending → furthest vetting stage (no premature green)
          CLEAR@ADJUDICATION_REVIEW → restore pre-flag stage from history
          REJECT → REJECTED; amber doc rows stamped human_reviewed_* (officer UUID)
```

Late vetting hard-fails (lifecycle.ts) follow the same policy: pre-slot →
REJECTED (unchanged), at/past SLOT_ASSIGNED → ADJUDICATION_REVIEW.

## Pieces

- `rls/0011_adjudication_review_status.sql` — enum value BEFORE 'REJECTED' ×3
  schemas; applied live + re-runnable; bootstrap step 12. No new grants
  (officers already hold SELECT/INSERT/UPDATE on document_records via 0001).
- shared-types: `DOCUMENT_FORENSICS_COMPLETED` event + `document.forensics`
  topic (partition-keyed by applicationId); `ForensicsFlags` perceptual checks
  now `boolean|null` (null = not analyzed — never a false "checked & clean").
- `services/document-forensics-service` — hexagonal; ports
  ForensicsAnalyzer / ObjectStore (GET-only) / VirusScanner /
  DocumentRecordStore; zero new npm deps (invariant #5 intact). Fail-closed:
  scanner down → 503, no verdict, no event. Per-agency document_type
  divergence (verified live: RDF 6 / RNP 5 / RCS 9 values) → clean 422.
  Idempotent re-analysis: one row per (application, object key), UPDATE not
  INSERT.
- application-service: `applyForensicsRouting` + projector + consumer (own
  group), `amber-queue` officer read (LEFT JOIN un-reviewed AMBER docs +
  adjudication holds), `adjudicate` officer write (Slice-4 DB-role pattern),
  `application.cleared` re-emit on adjudicated-green (D4 reconvergence).

## Proofs (gate 27)

- `document-forensics-service/selfcheck/verify-forensics-slice.ts` — live
  PG+MinIO+ClamAV+socket: EICAR→RED, clean JPEG→GREEN, stripped→AMBER,
  unknown container→AMBER, deferred flags null, idempotent re-analysis,
  PII-free events, cross-agency 404, 401/403/400/422, scanner-down 503
  fail-closed. The proof seeds objects with its OWN SigV4 PUT helper — the
  service port stays GET-only.
- `application-service/selfcheck/verify-amber-adjudication-slice.ts` — live
  PG+sockets with REAL scheduling wired: routing matrix (incl. redelivery +
  terminal guards), agency-scoped queue, CLEAR→GREEN→**SLOT_ASSIGNED e2e**
  (QR minted), pending-evidence clear lands at vetting stage, REJECT+stamps,
  late-hold restore-from-history, 409/404/401/403/400, append-only history,
  one ADJUDICATION audit per genuine decision.
- `verify-lifecycle.ts` extended: late-fail routing ×15 + hold stability.

## Ops notes

- Dev ClamAV: memory limit raised 512M→2G (clamd OOM-looped loading ~3.3M
  sigs) and healthcheck fixed to a TCP zPING probe (`clamdcheck` doesn't
  exist in clamav/clamav:stable). First boot downloads definitions — minutes.
- `document.forensics` created on the running broker; kafka-init updated for
  fresh boots. MinIO buckets are NOT auto-created; proofs self-provision.
- run-selfchecks.sh exports MINIO_*/CLAMAV_* dev defaults.

## Deferred (explicit)

Upload/portal + MinIO writes + virus-scan-on-upload · perceptual forensics
program (ELA/DCT/OCR — own ADR + labeled-corpus validation plan) ·
"dismissed-flag" marker for re-delivered stale evidence after a late-hold
clear · AmberLaneQueueItem-shaped BFF projection (queue returns a superset).
