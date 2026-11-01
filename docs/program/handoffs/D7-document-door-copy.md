# D7 — the document door: one code, one actor, one sentence

**From:** defect-closure phase 0 (backend lane) · **Date:** 2026-11-01 · **Backend head:** `e1c3488`
**Read with:** [`evaluation-2026-10-29.md`](../evaluation-2026-10-29.md) §2 (the defect) · [`D0-defect-closure.md`](../sessions/D0-defect-closure.md) (the fix)
**Rules:** every call goes through the edge gateway (`/edge/v1/**`), never to a service. Officer operations need a session (`x-usrp-session`) and CSRF on writes.

---

**Why it exists:** forensics and identity kept two hand-written lists of the codes the upload door can answer. They disagreed, so `INVALID_DOCUMENT_TYPE` (a citizen's mistake, permanently) reached the citizen as `503 UPSTREAM_UNAVAILABLE` ("try again later") — and would have, forever.

**What to render:** the code, in a closed set (`@usrp/shared-types` → `DOCUMENT_DOOR_CODES`). The **actor** field in that table says *who must act*, which is what the copy turns on.

| Actor | Citizen copy | Retry? |
|---|---|---|
| `CALLER` | "Something about this upload was not accepted. `<code-specific line>`." | no — changing the request fixes it |
| `UPLOADER` | "This file cannot be accepted. `<code-specific line>`." | no — a different file may be |
| `SYSTEM` | "We could not check your document just now. Please try again in a few minutes." | yes |
| `ELIGIBILITY` | "This application has moved past the point where documents are accepted." | no — contact the agency |

**Codes the door can answer** (status is in the shared table; use it, do not hard-code):

`INVALID_REQUEST` · `INVALID_FILENAME` · `MISSING_FILE` · `EMPTY_FILE` · `FORBIDDEN_FIELD` · `INVALID_DOCUMENT_TYPE` · `UNSUPPORTED_DOCUMENT_TYPE` · `APPLICATION_NOT_FOUND` · `NOT_ACCEPTING_DOCUMENTS` · `UNSUPPORTED_FILE_TYPE` · `UNSUPPORTED_FILE_CONTENT` · `CONTENT_TYPE_MISMATCH` · `DOCUMENT_REJECTED_MALWARE` · `FILE_TOO_LARGE` · `DOCUMENT_REFUSED` · `SCANNER_UNAVAILABLE` · `OBJECT_STORE_UNAVAILABLE` · `DOCUMENT_ENCRYPTION_ERROR` · `FORENSICS_PERSISTENCE_ERROR` · `DEPENDENCY_UNAVAILABLE` · `DOCUMENTS_UNAVAILABLE` · `INTERNAL_ERROR` · `DOCUMENT_REVIEW_CLOSED`

Two behaviours worth knowing:
- a document type USRP does not model at all is refused **at the door** by identity (`422 UNSUPPORTED_DOCUMENT_TYPE`) before anything is stored, so a typo in the wizard fails instantly and cheaply. Which *agency* accepts which type is the owning service's call (`AGENCY_DOCUMENT_TYPES`) — the wizard should pre-filter on `AGENCY_DOCUMENT_TYPES[agency]` so the per-agency refusal is never reached in normal use;
- an **unclassifiable** 4xx upstream becomes `DOCUMENT_REFUSED` (422) and logs `document_door_contract_drift`. If the console sees it, that is a bug on our side, not the citizen's: say "we could not accept this file" and file the log line.

---
