# ADR-052 — Document supersession and the review lock

**Status:** Accepted · 2026-11-01 (defect-closure session D0) · closes evaluation 2026-10-29 defect **D8**
**Deciders:** platform owner (2026-11-01, §2: supersede before review, refuse after)
**Relates to:** ADR-004 scan-before-store, ADR-011 amber lane, ADR-032 document requirements model, ADR-033 exam QR, ADR-006 single writer
**Migration:** `rls/0044_document_revisions.sql` (number provisional — renumber at rebase)

## 1. Context

The document door stores one object per `(agency, application, document type)` under a **derived, stable** key (`domain/object-key.ts`), and `document_records` keys its idempotency on `(application_id, minio_object_key)`. That decision had a real argument: a content-hash or timestamped key would leave the superseded object at rest forever, under a key no row points at — unreachable, un-analysed, and still a copy of a citizen's national ID.

So a second upload of the same type **silently becomes an update**:

- MinIO overwrites the object (the new bytes *are* stored);
- `document-record.pg-store.ts` finds the existing row and `UPDATE`s lane, score, size, flags, `forensics_completed_at`;
- the response returns **the same `documentId`**;
- `human_reviewed_by_id / human_reviewed_at / human_review_decision` are **not touched**.

Three defects follow, in ascending order of seriousness:

1. **Nothing distinguishes a replacement from a retry.** The citizen, the officer and the audit trail all see an unchanged document id.
2. **"Which bytes did the officer review?" is unanswerable.** There is no revision counter and no content digest; the bytes that were judged are gone and nothing records that they ever differed.
3. **A reviewed document can be laundered.** A citizen uploads a certificate, an officer reviews it `CLEAR`, and the citizen then uploads a different file to the same slot: the row keeps `human_review_decision = 'CLEAR'` while the bytes behind it change. That is evidence tampering with the platform's own approval stamp on it. Nothing in the code prevents it; `CLOSED_TO_UPLOADS` refuses only terminal statuses (`ACCEPTED`, `REJECTED`, `WITHDRAWN`, `WALK_IN_REJECTED`).

## 2. Owner decisions (2026-11-01)

| Decision | Taken |
|---|---|
| Meaning of a second upload before review | **Supersede**: allowed, versioned, visibly distinct, trail kept. |
| Meaning after a human review | **Refused** (`409 DOCUMENT_REVIEW_CLOSED`). A reviewed document is evidence; changing it needs an officer-initiated re-open, not a citizen upload. |
| Trail | Append-only revisions with a **keyed** digest (HMAC, not a bare hash). |
| The bytes at rest | Still one object per slot — the PII-minimisation argument stands; the *evidence of replacement* is what we add. |

## 3. Decision

### 3.1 A revision is an object

`document_records` (all three schemas, one migration) gains:

| Column | Purpose |
|---|---|
| `revision integer NOT NULL DEFAULT 1` | how many times this slot has been uploaded |
| `content_hmac varchar(64)` | identifies the bytes **without** being a confirmation oracle |

and a new append-only table per schema, `document_revisions`:

| Column | Note |
|---|---|
| `id`, `document_id` (FK), `application_id` | the slot and the case |
| `revision` | unique per `(document_id, revision)` |
| `content_hmac`, `file_size_bytes`, `mime_type` | what arrived |
| `forensics_lane`, `forensics_score`, `forensics_flags` | what the door concluded about it |
| `uploaded_at`, `uploaded_by` | when, and by whom (`APPLICANT` is the only actor today) |

One row per upload. Never updated, never deleted. `document_records` remains **the live slot**; `document_revisions` is **the record of what passed through it**.

### 3.2 HMAC, not SHA-256

A bare digest of a national ID or a birth certificate is a confirmation oracle: anyone holding a candidate document can verify a guess against the table. The digest is therefore keyed with the document service's own secret (the `clearance_certificate_verifications.reference_hmac` idiom). The HMAC never leaves the service and never reaches an audit event or a citizen response; the audit carries the **revision number** and the **previous verdict**, which is what a reviewer needs.

### 3.3 The door closes where review begins

A replacement upload is accepted while **both** hold:

- the application's status is at or below `DOCUMENT_REVIEW_AMBER` in the canonical `APPLICATION_STATUSES` order (the same rank function the lifecycle uses — no hand-written status list), and
- the slot has no `human_reviewed_at`.

Otherwise: **`409 DOCUMENT_REVIEW_CLOSED`**, a closed code in the shared document-door vocabulary (ADR-053's sibling constant), with citizen copy in the front-end hand-off. The refusal is auditable (`DOCUMENT_REUPLOAD_REFUSED`) and names no internals.

### 3.4 Revision assignment cannot skip or duplicate

Inside the same `FOR UPDATE` transaction that claims the row:

1. `SELECT … FOR UPDATE` the slot (serialises concurrent uploads of one document);
2. `revision = current.revision + 1`;
3. `INSERT document_revisions`;
4. `UPDATE document_records` (lane, score, flags, size, HMAC, `revision`, `forensics_completed_at`), leaving `human_review_*` **null** — provably, because §3.3 refused the write if they are set.

A retried upload of **identical** bytes is still one revision: the store's idempotency key `(application_id, minio_object_key)` is unchanged, and the digest of the incoming bytes is compared with the slot's `content_hmac` — equal bytes, equal revision, `NO_CHANGE`.

### 3.5 The response says what happened, and nothing more

```
201 { status: 'UPLOADED', documentId, documentType, revision }
```

No lane, no score, no flags: a verdict handed to the uploader is a forgery-tuning oracle (the existing rule, and the reason the leak-guard test will cover the new field). `revision` is safe — it reveals that a document was replaced, not how it scored.

### 3.6 The escape hatch exists even though its code waits

The refusal must never be a dead end. The ADR names the future officer operation (`document.reopen`, permission `document.reopen`, S06/S14 territory) that unlocks a reviewed slot and forces a fresh review. Phase 0 ships the refusal and the documented path; it does not ship the re-open.

## 4. Rejected alternatives

| Alternative | Why not |
|---|---|
| **Versioned object keys (`…/v2`) and a new row per upload** | Discards the PII-minimisation argument that justified the stable key: every superseded copy of a national ID stays in the bucket, unreachable by any row's read path unless we build one. |
| **Always allow, clear the review stamp, force re-review** | Makes the review reversible by the applicant, indefinitely. A citizen can reopen a closed case at will, and the officer's recorded decision becomes advisory. |
| **Refuse all re-uploads** | One blurred phone photo becomes an officer-only fix. It is a real workflow, not an abuse. |
| **Keep only a `superseded_at` timestamp** | Answers "was it replaced" but not "with what", and still lets the stamp outlive the bytes (defect 3). |
| **Compare files by size/mtime** | Not evidence. |

## 5. Consequences

- The audit trail can now answer the only question a reviewer, an appeal or a court will ask: *which bytes did the officer approve?*
- Write path: one extra `SELECT … FOR UPDATE` (already taken), one extra `INSERT`, one extra column update — no new round trip.
- Storage: one small row per upload per document; the object count is unchanged (the PII argument holds).
- The citizen can still correct a mistake, but only while it is a mistake to correct. After review, the path is an officer's.
- The old `documentId`-is-stable behaviour is gone from the wire only insofar as `revision` is added; ids remain stable, which keeps existing console links valid.
- `document_records` and `document_revisions` must be identical in all three schemas — asserted by the cross-schema shape proof (the D1-class guard), not eyeballed.

## 6. Not decided here

- Retention of superseded revisions (rows are kept; no purge policy yet — DPO decision, `ROADMAP.md` §6 item 3).
- Whether the officer console must show revision history before adjudicating (recommended; S06 screen).
- Notarised/venue-verified documents (ADR-032, rls/0030) — a venue mark is write-once and is **not** affected by §3.3, which is about uploads.
