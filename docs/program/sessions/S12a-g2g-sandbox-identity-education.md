# S12a — G2G production sandbox: platform, NIDA and NESA (backend)

**M3 (starts now; needs no G2G agreement) · backend · depends on nothing unmerged** · Branch `feat/s12a-g2g-sandbox` · Reserved: **ADR-047** (finalise it from "Proposed")

## Why
Every G2G adapter today talks to an invented contract (hash-keyed HMAC POSTs), so all of them would be rewritten at cutover. The owner has captured real responses from IremboGov (NIDA identity information), SDMS (NESA results) and Irembo certificate verification (ADR-047 §1). This session builds the production-like sandbox and moves identity and education onto the real wire formats. It also closes the NESA binding gap (ADR-048 §2.2).

## Read first
- ADR-047 and ADR-048 (both Proposed; this session finalises ADR-047).
- ADR-028, ADR-029 and ADR-035.
- `services/identity-service/src/{ports/nida.gateway.ts,adapters/nida.http-gateway.ts,domain/nida.types.ts}`.
- `services/eligibility-service/src/{ports,adapters,domain}/nesa*`, plus `education-rules.ts`.
- `infrastructure/docker/mocks/**`.
- `packages/shared-config/src/production-guard.ts`.
- `scripts/check-tracked-secrets.mjs`.
- The owner decisions in ADR-047 §2.

## Privacy rules (mandatory, mechanical)
- **The owner's real record never enters git, CI, logs or fixtures.** It lives in `~/Documents/projects/e-recruitment-software/sandbox-demo/`, outside both repositories.
  - Read only its **shape**, field names and types. Never copy a value into a tracked file, a commit message, a PR body or a log line.
  - The private-persona loader (ADR-047 §3.5) reads it at runtime only, and refuses any path inside a git work tree.
- **The third-party certificate** in sandbox-demo (its PDF and the JSON verification sample) is **shape only**. No value from it may be used anywhere.
- `sandbox-demo/e-recruitment.md` contains live credentials (Irembo bearer tokens, a Twilio account SID and an auth token). **Never read them into a tool output, a file or an env file you create.** Twilio credentials are the owner's to place in an untracked env file (S12b).

## Delivers
1. **`USRP_ENVIRONMENT=sandbox`** profile (ADR-047 §3.1):
   - the production boot guard in full;
   - the two-way fences (simulator only in sandbox or development; production refuses simulator hosts and `x-usrp-sandbox`; sandbox refuses real registry hosts);
   - selfchecks proving each fence.
2. **`tools/g2g-sandbox/`:** one dependency-free server on `shared-http` mounting:
   - `nida-irembo`;
   - `nesa-sdms`;
   - an empty mount point for `irembo-certificates` and `sms-twilio`. S12b fills these, so define the simulator module interface for it.

   Paths and envelopes copy ADR-047 §3.2 exactly. JSON Schemas of each captured shape go in `tools/g2g-sandbox/contracts/` with values stripped, and the simulators are tested against them.
3. **Behaviour profiles** (ADR-047 §3.3): latency distribution, 429 with `Retry-After`, 503 maintenance, timeout, truncated body, `status:false` with 200, all data quirks, and a per-client token bucket. Each is selectable per persona and, in sandbox, per request (`x-usrp-sandbox-behaviour`).
4. **Synthetic population** (ADR-047 §3.4):
   - a deterministic generator with a seed;
   - authoritative provinces and districts (sector, cell and village labelled synthetic);
   - synthetic portraits and signatures;
   - the documented synthetic NID serial block;
   - a **scenario persona catalogue**: named personas with stable IDs for every path listed in ADR-047 §3.4, plus personas aligned to the five real announcements (§8).
5. **Private persona overlay** (ADR-047 §3.5): `SANDBOX_PRIVATE_PERSONA_DIR`, kept in memory only, with logger redaction.
6. **Personal-data rule** in `check-tracked-secrets.mjs`, with a red `--selftest`. It flags:
   - a 16-digit NID outside the synthetic block;
   - a base64 JPEG longer than 1 KiB in JSON fixtures;
   - Rwandan E.164 numbers outside the synthetic range.

   **Audit the existing fixtures:** NIDs such as those in `infrastructure/docker/mocks/nida/data/citizens.json` and the rehearsal personas may be structurally valid real NIDs. Move them into the synthetic block, or allowlist them with a reason.
7. **Adapters on the real formats:**
   - `NidaIremboGateway`: identity mapping, `DD/MM/YYYY` dates, surname and forename. Its transport module is separate from the mapping, so it can be swapped at cutover.
   - `NesaSdmsGateway`: holder fields included.

   Both have unit tests on the captured shapes and live selfchecks against the simulator. Retire the old hash-keyed NIDA and NESA mocks in the same PR that removes their last caller.
8. **`packages/shared-identity-match`** (ADR-048 §2.1), pure with property tests: diacritics, token order, case, edit distance 1, DOB formats.
9. **NESA binding** (ADR-048 §2.2):
   - the eligibility service binds before evaluating;
   - `published:false` gives PENDING; `malpractice` gives REVIEW;
   - the TVET-at-A2 default;
   - `NOT_BOUND` yields a correctable "record does not match your identity" outcome (edge outcome code, citizen-safe).

   **Confirm first** that the binding gap is real (read `verify-nesa-education.service.ts` end to end). Record what you find in ADR-047 or ADR-048.
10. **Live-NESA passthrough** (ADR-047 §3.6): opt-in, one allowlisted index set locally, 1 request per minute, and its schema re-validated. It is **not** run in CI.
11. **`pnpm sandbox`:** boots the sandbox profile on its own database (`usrp_sandbox`) and its own ports (49xx). `pnpm sandbox:reset` drops that database.
12. **Rehearsal scenarios from the real announcements**, encoded from **`docs/product/recruitment-announcements-2025-2026.md` only.** That document was extracted from the signed Kinyarwanda originals.
    - **The English translations in sandbox-demo are wrong in material ways** (§7 of that document: dates, exam hour, a reversed age limit, provinces, an invented bankruptcy requirement). Never use them.
    - There are six campaigns: RDF regular + Reserve 2026, RNP Basic 2025, RNP Cadet 2025, RCS junior 2025, RCS officer 2026 (1-year and 4-year tracks). Each becomes a `tools/rehearsal/scenarios/*.json`, fenced as rehearsal (`REH-` codes and labels), with:
      - the per-category and per-qualification age caps;
      - education alternatives;
      - the agency's conviction rule;
      - the documents list;
      - venues and dates as in the originals.
    - The genuine inconsistencies in the originals (§8: RCS junior heading vs district dates; RNP brochure vs announcements; walk-in on exam day announced by RCS officer as well as RDF) are recorded as scenario notes and listed in the hand-off. Do not silently fix them.
    - Where the policy model cannot yet express a fact (for example several age caps by qualification within one category, or "not under prosecution"), say so in the hand-off. Do not approximate it silently.
    - **Pre-fill:** the forms' identity block maps onto the NIDA record (§6). Add the mapping to the hand-off, as an input for the frontend apply flow.

## Owns
- `tools/g2g-sandbox/**`
- `packages/shared-identity-match/**`
- the NIDA adapter and its config in identity-service
- the NESA adapter, domain and service in eligibility-service
- `tools/rehearsal/scenarios/*` (new files only)
- ADR-047
- the personal-data rule in `scripts/check-tracked-secrets.mjs`
- sandbox entries in compose and `.env.example` (shared, append-only)

## Quality bar
- Every simulator response validates against its captured schema, and every adapter maps every captured field or names why it doesn't.
- Every fence is proven red and green.
- `pnpm sandbox` + `pnpm rehearse --scenario rnp-basic-2025` runs the full journey on synthetic personas: sign-in through the Twilio emulator inbox (or the dev inbox until S12b), application, NIDA lookup, NESA bound, slot, then gate. The over-age, S3-only, NESA name-mismatch, unpublished and malpractice personas each land in their correct outcome.
- **Locally only, not in CI or a PR:** with the private persona set, the owner's own identity onboards, and the live-NESA passthrough binds the owner's real results. Report only that it passed, with no values.
- `/security-review` is mandatory (personal data, fences, boot guard).

## Exit gate
- [ ] Sandbox profile and fences merged, with proofs.
- [ ] NIDA and NESA on real formats, with binding.
- [ ] Old NIDA and NESA mocks retired.
- [ ] Personal-data rule red in its selftest and green on the tree.
- [ ] The five announcement scenarios are encoded, with discrepancy notes.
- [ ] CI is green on the PR head; ADR-047 is Accepted; capability map and status board are updated.
- [ ] A hand-off for S12b covers the simulator module interface, the persona catalogue IDs and the binding API.

## Owner decisions (defaults if not answered)
- **TVET at A2 counts as A2:** default yes, recorded as "owner to confirm".
- **RCS science 70% on `weightedPercent`:** default yes, plus listed subjects where present.
- **Malpractice handling:** default REVIEW, never automatic.

## Session starter
```text
You are the principal backend and security engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment.

This is session S12a — G2G production sandbox: platform, NIDA and NESA. Read your kit e-recruitment/docs/program/sessions/S12a-g2g-sandbox-identity-education.md, then ADR-047 and ADR-048, docs/program/ROADMAP.md (§2, §8.4), docs/program/README.md and quality-workflow.md, and follow them.

Goal: a USRP_ENVIRONMENT=sandbox profile with two-way fences, a dependency-free simulator server that speaks the real IremboGov/NIDA and SDMS/NESA wire formats with behaviour profiles, a synthetic national population and scenario personas, a runtime-only private persona overlay, a CI personal-data rule, NIDA and NESA adapters on the real formats, credential-to-identity binding (shared-identity-match) closing the NESA binding gap, an opt-in live-NESA passthrough, pnpm sandbox, and rehearsal scenarios encoded from the five real announcements with their source discrepancies recorded, not fixed.

PRIVACY (mandatory): sandbox-demo/ holds the owner's real record and a third party's certificate. Read the shape only; never copy a value into a tracked file, commit, PR, log or tool output, and never read the credentials in sandbox-demo/e-recruitment.md. Use ADR-047 only. /security-review is mandatory. Work in your own worktree under ~/Documents/projects/e-recruitment-software/worktrees/, use your own database and ports 49xx, never kill TTY processes, and never restart shared containers. Done = CI green on the PR head, sandbox journey proven, status board and capability map updated, hand-off note for S12b.
```
