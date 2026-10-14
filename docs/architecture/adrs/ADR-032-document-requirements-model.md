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

## Owner decisions — RECORDED 2026-10-14
| Question | Decision | Where it is enforced |
|---|---|---|
| Advisory, blocking, or check-in only? | **Advisory** | No transition reads the checklist; proven by `verify-document-checklist.ts` (status unchanged after reads and venue clearing) |
| Does an automated verification waive the paper? | **Yes** | `API_VERIFIED` satisfies the item, nothing uploaded required |
| Who clears a document at the venue? | **The front-door on-site officer who checks candidates in** | Permission `document.verify.venue` → `screening_officer` only; `POST /v1/applications/documents/verify-at-venue`; attributed, audited once, write-once (rls/0030) |
| Notarised diploma: is the registry enough? | **Upload, then registry verification** | `BOTH_REQUIRED`: cleared upload AND the category's academic registry (HEC for degree categories); a venue sighting does not replace the upload; `AWAITING_REGISTRY` in between |

### Flag raised with the decision
RCS **General Enlistee** lists `DEGREE_DIPLOMA_NOTARIZED`, but the category is
NESA-path (A-Level), so HEC never runs for it. The rule is implemented as "the
category's OWN academic registry", which is HEC for every degree category and
NESA for General Enlistee. Please confirm, or correct the ground-truth entry
(it may really be a notarised A-Level certificate).

## Surfaces
- `GET /v1/applications/document-checklist?applicationId=` — officer, own agency, `application.read`.
- `GET /v1/applications/document-checklist/by-applicant` — system token (identity bridge), subject-scoped.
- `POST /v1/applications/documents/verify-at-venue` — `document.verify.venue`; 404 other agency, 409 terminal, 422 type not required, idempotent re-scan.
