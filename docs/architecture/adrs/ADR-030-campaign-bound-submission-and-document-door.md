# ADR-030 — Campaign-bound submission, policy binding, and the citizen document door

**Status:** Accepted (BUILD-002, increment 2)

## Context
A citizen submitted a *category*; application-service silently picked "the
newest open campaign for that agency". Two simultaneous openings were
indistinguishable, the application recorded no policy, and eligibility
consumers evaluated against their own wall clock. Citizens also had no way to
upload documents: document-forensics accepts uploads only under a system token.

## Decision
1. **The citizen names the campaign by its public code** (`campaignCode`). The
   server resolves the authoritative campaign (REGISTRATION_OPEN, window live,
   agency matches the category, category targeted). Unknown / closed /
   wrong-agency are one `NO_OPEN_CAMPAIGN`. Required at the edge and the
   identity bridge; optional at application-service for system callers.
2. **The code is part of the request hash** (appended only when present, so
   hashes recorded earlier still replay): same key + other code = `KEY_REUSED`.
3. **Policy and date are bound at filing** — `applications.policy_version_id`
   and `evaluation_date` (Africa/Kigali), write-once (rls/0029 trigger, binds
   admin too). The same values ride on `APPLICANT_SUBMITTED`
   (`policyVersionId`, `referenceDate`); the age consumer evaluates against
   `referenceDate`, so a delayed/replayed event cannot flip a boundary case.
4. **Document door:** `POST /edge/v1/me/applications/documents`. The edge parses
   the browser's multipart under hard limits and **composes a new one**;
   identity-service authenticates the opaque session, derives the subject,
   re-composes again and forwards to document-forensics under its own system
   token. A client `applicantId` is refused at both tiers. The response is
   `{ documentId, documentType }` — never lane/score/flags.

## Superseded / follow-ups
- **Required documents — CORRECTION.** An earlier draft said "no official list
  is invented here". That was wrong: `REQUIRED_DOCUMENTS` in shared-types
  already transcribes each agency's announced list per category, and campaign
  policy versions carry `requiredDocumentTypes`. The model and the owner
  decisions (advisory; API waives paper; venue clearing by the check-in post;
  notarised = upload then registry) are in **ADR-032**.
- Education/vetting consumers still stamp their own clock for audit fields;
  only the age decision is date-bound today.
