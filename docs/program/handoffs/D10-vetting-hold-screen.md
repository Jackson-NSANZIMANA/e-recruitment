# D10 — the vetting-hold verb, the queue’s `actions`, and separation of duties

**From:** defect-closure phase 0 (backend lane) · **Date:** 2026-11-01 · **Backend head:** `e1c3488`
**Read with:** [`evaluation-2026-10-29.md`](../evaluation-2026-10-29.md) §2 (the defect) · [`D0-defect-closure.md`](../sessions/D0-defect-closure.md) (the fix)
**Rules:** every call goes through the edge gateway (`/edge/v1/**`), never to a service. Officer operations need a session (`x-usrp-session`) and CSRF on writes.

---

**Why it exists:** the amber queue listed applications held on a criminal-clearance review or a NESA review, and **no operation could act on them**. The screen showed work that could not be done.

**New operation**

```
POST /edge/v1/applications/vetting-hold
permission: vetting.hold.resolve        (granted to adjudicator only)
csrf: true
{
  "applicationId": "…uuid…",
  "dimension": "CRIMINAL" | "ACADEMIC",
  "decision": "CLEAR" | "REJECT",
  "reasonCode": "…",                     // closed set, below
  "notes": "…optional, ≤1000 chars…"
}
```

**The reason IS the verdict — render it that way.** Each reason already names its dimension and its decision, so the console should offer the *reason*, not a reason plus a decision toggle; a mismatched pair is refused `422 INVALID_VETTING_HOLD_REASON` (by the edge and again by the service).

| reasonCode | dimension | decision | Meaning to show |
|---|---|---|---|
| `CLEARANCE_CONFIRMED` | CRIMINAL | CLEAR | Record obtained, no disqualifying entry |
| `CLEARANCE_IDENTITY_RESOLVED` | CRIMINAL | CLEAR | Partial name on the certificate resolved to this applicant |
| `CONVICTION_CONFIRMED` | CRIMINAL | REJECT | Disqualifying conviction confirmed |
| `PROSECUTION_CONFIRMED` | CRIMINAL | REJECT | Active prosecution confirmed |
| `PUBLIC_SERVICE_DISMISSAL_CONFIRMED` | CRIMINAL | REJECT | Dismissal from public service confirmed |
| `NESA_RECORD_CONFIRMED` | ACADEMIC | CLEAR | NESA confirmed the record |
| `NESA_DOCUMENT_VERIFIED` | ACADEMIC | CLEAR | Qualification verified against the document supplied |
| `QUALIFICATION_NOT_RECOGNISED` | ACADEMIC | REJECT | Qualification not recognised for this category |
| `ACADEMIC_REQUIREMENT_NOT_MET` | ACADEMIC | REJECT | Verified record does not meet the requirement |

Import the list from `VETTING_HOLD_REASONS` — do not copy it into the UI.

**Response (200)** — exactly these five fields:

```json
{ "status": "APPLIED", "dimension": "CRIMINAL",
  "fromStatus": "CRIMINAL_CLEARANCE", "toStatus": "DOCUMENT_REVIEW_GREEN",
  "statusChanged": true }
```

`statusChanged: false` (then `fromStatus === toStatus`) is a **success**: the evidence was written on an application that had already moved on — a late hold. Do not render that as a failure, but do re-read the row, because the queue item is gone.

**Refusals** — each carries `status`, never a bare error string:

| HTTP | `status` | Extra | What the console does |
|---|---|---|---|
| 409 | `NOT_HELD` | `dimension`, `currentStatus` | the item is no longer held (another officer resolved it, or it was never genuinely held) — re-read the queue, **no** error toast |
| 404 | `NOT_FOUND` | — | the application is gone for this agency — drop the row |
| 403 | `FORBIDDEN` | — | this officer has no `vetting.hold.resolve`; do not render the button |
| 403 | `SEPARATION_OF_DUTIES` | `rule` | see below |
| 422 | `INVALID_VETTING_HOLD_REASON` | `reason` (the offending code) | console bug — the reason contradicts the request; report it, do not retry |
| 400 | `INVALID_APPLICATION_ID` / `INVALID_NOTES` / `MISSING_APPLICATION_ID` | — | console bug |

`rule` is `ACCEPT_EXCLUDES_CLEARANCE_REVIEWER` when this verb is refused (an officer may not resolve a hold on an application they already accepted); `ACCEPT_EXCLUDES_FINAL_DECIDER` guards the accept verb.

**The queue now says which verb applies.** Every queue row carries a closed `actions` array — `["ADJUDICATE"]`, `["RESOLVE_VETTING_HOLD"]`, or both (an amber document hold on an application whose clearance is also under review). Render one button per action instead of inferring from `status` + `reasons`; that inference is exactly how "Adjudicate" came to be offered where only a resolution could work.

**Separation of duties (on by default).** The officer who resolved a hold may **not** accept that application:

```
403 { "status": "SEPARATION_OF_DUTIES", "rule": "ACCEPT_EXCLUDES_CLEARANCE_REVIEWER" }
```

Copy: "You resolved this application's vetting hold, so another officer must record the final decision and acceptance." The accept button should be disabled, with that reason, as soon as the row shows a resolution by the signed-in officer. Symmetrically, an officer who already accepted an application cannot resolve its hold (`ACCEPT_EXCLUDES_CLEARANCE_REVIEWER`): hide that action from that officer's row.

---
