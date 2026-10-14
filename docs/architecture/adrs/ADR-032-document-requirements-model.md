# ADR-032 — Document requirements: what is required, and what "satisfied" means

**Status:** Accepted (model + pure domain). **Enforcement is NOT decided** — see
"Owner decisions".

## Context
`REQUIRED_DOCUMENTS` (shared-types) transcribes each agency's announced list
per category, and campaign policy versions carry `requiredDocumentTypes` — yet
nothing consumed either. The announcements also matter: RNP and RCS say
candidates "present themselves with / bring" the documents, and RDF admits
walk-ins who pre-registered nothing. A hard "no upload ⇒ no progress" gate
would contradict the very announcements the system encodes.

## Decision
1. **Resolution:** the application's bound policy version's list wins; the
   ground-truth table is the fallback; they are never merged. An explicitly
   empty policy list is respected.
2. **Satisfaction is a state, not a boolean:** `API_VERIFIED`,
   `UPLOADED_CLEARED`, `UNDER_REVIEW`, `REJECTED`, `MISSING`.
3. **API verification derives from the application's real gate verdicts**
   (NIDA identity, NESA/HEC academic for the category's own registry, RIB
   criminal) — never from the document type alone. Types with no registry
   (conduct, celibacy, birth, medical, notarised copy, signed form) can only be
   uploaded or presented.
4. `evaluateDocumentChecklist` is pure and advisory. It never decides "may
   proceed".

## Owner decisions (engineers flag, they do not decide)
- Is the checklist **advisory**, **blocking before slot assignment**, or
  **verified at check-in only**? Per agency? Per campaign?
- Does an API confirmation **waive** the paper copy at the venue?
- Is a notarised diploma verified by HEC enough, or is the notarised paper the
  requirement?
- Who may clear a document at the venue, and is that recorded as a document
  event with the officer's identity?

## Recommended course (proposed, not implemented)
1. Expose the checklist read-only to the citizen ("done / under review / bring
   or upload") and the officer.
2. Record **presentation at check-in** as a document event (BUILD-003).
3. Only then, if the agencies decide so, add a blocking rule at the chosen
   transition, behind the policy document — not a global switch.
