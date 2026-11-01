# D11 — the authenticated officer is the only actor; per-record sync outcomes

**From:** defect-closure phase 0 (backend lane) · **Date:** 2026-11-01 · **Backend head:** `e1c3488`
**Read with:** [`evaluation-2026-10-29.md`](../evaluation-2026-10-29.md) §2 (the defect) · [`D0-defect-closure.md`](../sessions/D0-defect-closure.md) (the fix)
**Rules:** every call goes through the edge gateway (`/edge/v1/**`), never to a service. Officer operations need a session (`x-usrp-session`) and CSRF on writes.

---

**Why it exists:** the device, not the platform, decided who captured a citizen's physical test. A signed claim naming anyone other than the authenticated officer is now refused.

**Two new things on `POST /edge/v1/field-scores/sync`:**

1. **Shape** — a non-UUID `capturingOfficerId` is `400` (edge and service), never a database `500`. Validate it in the tablet's client model too.
2. **Per-record outcomes** — the batch response is per record, and **one bad record does not lose the batch**:

```json
{ "status": "SYNCED", "results": [
  { "applicationId": "…", "deviceId": "…", "status": "ACCEPTED", "scoreId": "…" },
  { "applicationId": "…", "deviceId": "…", "status": "REJECTED", "reason": "OFFICER_MISMATCH" }
] }
```

`results` is aligned to the request order; `status` is one of `ACCEPTED | SUPERSEDED | STALE | DUPLICATE | CONFLICT | NOT_FOUND | REJECTED`, and `reason` appears only on `REJECTED`:

| `status` | `reason` | Tablet behaviour |
|---|---|---|
| `ACCEPTED` | — | mark synced |
| `REJECTED` | `OFFICER_MISMATCH` | **do not retry**: the record was signed by a different officer on this device. Surface it to the supervisor — the device is being used under the wrong sign-in. |
| `REJECTED` | `BAD_SIGNATURE` | do not retry; the record or the key is wrong |
| `REJECTED` | `UNENROLLED_DEVICE` / `REVOKED_DEVICE` | re-enrol / call the supervisor |
| `REJECTED` | `AGENCY_MISMATCH` | wrong agency sign-in |
| `REJECTED` | `TICKET_MISMATCH` / `NOT_ADMITTED` | the candidate is not admitted to this venue |

`FieldScoreRejectReason` in `@usrp/shared-types` is the closed set — render from it, and keep a "needs supervisor" bucket for `OFFICER_MISMATCH` rather than an error toast.

**Still open (not phase 0):** the **supervisor countersign** on the physical and medical stations (S08/S14). Phase 0 delivers the precondition — an actor that cannot be forged — not the countersign itself.
