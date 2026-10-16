# S00 — Programme integrity

**Phase 0 · both repos · runs alone, first** · Branches: `chore/s00-integrity` in each repo where code or config changes.

## Why
Every later session relies on three promises:
- `main` is green and stays green;
- the docs describe the code;
- `pnpm rehearse` exists on `main`.

None of the three holds today. Frontend `main` is red (PR #27 pending). Both mains are unprotected; that is how a red PR merged. The rehearsal lives on unmerged branches, and the capability map was stale within a day.

## Read first
1. `docs/program/README.md`, `delivery-programme.md`, `quality-workflow.md` (backend)
2. `docs/architecture/capability-map.md` (backend), the rows S00 must correct
3. `docs/security/SECRET-ROTATION.md` (backend), its closure checklist
4. Frontend: `docs/architecture/frontend-architecture.md`, `cross-repo-contract-reconciliation-2026-10-04.md`, and `frontend-revamp-plan-2026-10-15.md` §4 (W0-01, W0-03, W0-04)

## Preconditions
```bash
gh auth status                                    # logged in as the repo owner
gh pr view 27 --repo Jackson-NSANZIMANA/e-recruitment-ui --json state,mergeable
gh run list --repo Jackson-NSANZIMANA/e-recruitment-ui --branch chore/wave-0-evidence-hygiene --limit 1   # green
```

## Owns
- Branch protection settings
- `.github/pull_request_template.md` (both repos)
- Capability map corrections
- Frontend architecture docs
- `SECRET-ROTATION.md` closure section
- CI evidence-bundle job (both CIs)

Nothing else.

## Work plan
1. **Merge PR #27** (frontend). Confirm `main` is green: `gh run list --branch main --limit 1`.
2. **Open and merge the rehearsal PRs.**
   - Backend `feat/rehearsal` → `main`: a single commit, ADR-035.
   - Frontend `feat/rehearsal` → `main`. After #27 it diffs to the rehearsal work only.
   - Wait for green CI on each PR head before merging.
3. **Protect both mains**, via `gh api -X PUT repos/<owner>/<repo>/branches/main/protection`:
   - required status checks:
     - backend: `TypeScript Type Check`, `Lint (ratchet, baseline 0)`, `Proofs (RLS isolation + service selfchecks)`, `Security Scan`;
     - frontend: `Quality Gate`;
   - strict (up to date before merge);
   - PRs required, no force-push, no deletion;
   - `enforce_admins` per the owner's answer.

   **Verify** by opening a throwaway PR with a failing check and confirming GitHub blocks the merge.
4. **Install the PR template** from `quality-workflow.md` in both repos.
5. **Correct the docs to match the code.**
   - Capability map: BUILD-001 real-PostgreSQL acceptance is proven in CI (P5–P17 plus the populated upgrade); only the provisioner-auth proof is skipped. The campaign operations exist in the frontend registry as untyped IDs. Rehearsal (ADR-035) has its own row. Last-verified header: today plus the SHAs.
   - Frontend `frontend-architecture.md` and the contract reconciliation: current SHAs, 43 operations, and pointers to the CI evidence bundle instead of hand-written counts.
   - Rename the baseline to `docs/product/usrp-national-baseline-v1.md`, with an errata box covering ADR-034, the SHAs and the operation count (W0-01).
6. **CI evidence bundle** (W0-04), one job per repo, uploaded as an artefact `evidence-<sha>.json`:
   - commit SHA and pinned peer SHA;
   - operation inventory;
   - proof and test counts, **with skipped tests listed separately**;
   - lockfile hash.
7. **Secret rotation: close or re-scope, in writing.** Recommended resolution:
   - No production secret has ever existed, so production secrets are generated fresh in KMS (S07) and never derived from any dev value.
   - Dev secrets are regenerated (`bash scripts/generate-env.sh --force` per developer).
   - Record the owner's history-rewrite decision.
   - Tick or mark *not applicable, because…* each checklist item.
8. **Record the owner's repository-visibility decision** in `delivery-programme.md` §7.

## Exit gate
- [ ] Both mains green; branch protection blocks a red PR (demonstrated).
- [ ] `pnpm rehearse` works on backend `main`; the live rehearsal spec is on frontend `main`.
- [ ] The capability map and frontend docs agree with the code (spot-check three claims against source).
- [ ] The evidence-bundle artefact appears on a `main` CI run in both repos.
- [ ] SECRET-ROTATION has a closure note; the visibility decision is recorded.
- [ ] Status board: S00 done; S01, S02 and S03 marked ready.

## Owner decisions (ask; default if no answer)
| Decision | Default |
|---|---|
| Should admins also be blocked by branch protection (`enforce_admins`)? | yes |
| Repository visibility: stay public, or go private? | stay public, record the rationale |
| Rewrite history to purge the August `.env` copy? | no rewrite; rotation covers it, because no production secret ever existed |

## Hand-off
- The list of required check names now enforced.
- The location of the evidence bundle.
- Corrections made to the capability map.

## Session starter
```text
You are the principal engineer on USRP, Rwanda's national security-sector e-recruitment platform (RDF, RNP, RCS). Repos: ~/Documents/projects/e-recruitment-software/e-recruitment (backend) and .../e-recruitment-ui (frontend).

This is session S00 — Programme integrity. Your kit is e-recruitment/docs/program/sessions/S00-programme-integrity.md: read it, then docs/program/README.md and docs/program/quality-workflow.md, and follow the quality workflow exactly.

Goal: both mains green and protected, rehearsal merged, docs true to the code, CI evidence bundles, and a written closure of the secret rotation.

Rules: ask me the owner decisions listed in the kit before acting on them; do not merge anything whose CI is not green on its head; never kill processes that have a TTY (I run my own pnpm dev). Finish by updating the status board and giving me the hand-off.
```
