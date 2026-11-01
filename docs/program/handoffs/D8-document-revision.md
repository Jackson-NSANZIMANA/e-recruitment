# D8 — documents carry a revision, and the door closes after review

**From:** defect-closure phase 0 (backend lane) · **Date:** 2026-11-01 · **Backend head:** `e1c3488`
**Read with:** [`evaluation-2026-10-29.md`](../evaluation-2026-10-29.md) §2 (the defect) · [`D0-defect-closure.md`](../sessions/D0-defect-closure.md) (the fix)
**Rules:** every call goes through the edge gateway (`/edge/v1/**`), never to a service. Officer operations need a session (`x-usrp-session`) and CSRF on writes.

---

**Why it exists:** a second upload of the same document type used to replace the bytes silently, keeping the officer's `CLEAR` stamp. A citizen could get a certificate approved and then swap the file.

**Upload response (201) now carries `revision`:**

```json
{ "status": "UPLOADED", "documentId": "…", "documentType": "NATIONAL_ID", "revision": 2 }
```

- `revision: 1` — first upload into this slot;
- `revision: n+1` — the citizen **replaced** an earlier, not-yet-reviewed upload;
- unchanged `revision` — the same bytes were retried (a retry is not a revision);
- still **no** lane, score or flags. Never display a verdict on the upload screen; the console gets verdicts from the officer reads.

**After review the door is closed:**

```
409 { "error": "DOCUMENT_REVIEW_CLOSED", "reason": "HUMAN_REVIEWED" | "CASE_ADVANCED" }
```

Copy:
- `HUMAN_REVIEWED` — "This document has already been reviewed. To replace it, contact the recruitment office to re-open it."
- `CASE_ADVANCED` — "This application has moved past document review, so documents can no longer be replaced."

The officer re-open (`document.reopen`) is **not shipped** in phase 0 (ADR-052 §3.6); the copy must therefore send the citizen to a human, not to a button that does not exist.

**Officer side:** the application detail read carries the revision trail (one row per upload: revision, size, type, lane, score, uploaded at). Recommended: show it before adjudicating, so a reviewer can see *which* upload they are judging.

---
