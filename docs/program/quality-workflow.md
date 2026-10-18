# The USRP session quality workflow

Every session follows this workflow, whoever or whatever runs it. It exists because each rule below was learned from a real failure in this repository. The failures are cited, so nobody "simplifies" a rule away without knowing why it is there.

## The nine stages

### 1. Ground

Read the session kit, then everything it lists under *Read first*. Then check the state of the world:

```bash
# both repos up to date, both mains green in CI
cd e-recruitment     && git switch main && git pull && gh run list --branch main --limit 1
cd ../e-recruitment-ui && git switch main && git pull && gh run list --branch main --limit 1
```

If either `main` is red, **stop**. Fixing it is the first task (2026-10-16: a red PR merged and broke `main`).

### 2. Branch

Use one branch per session, named in the kit: `feat/sNN-…`, `fix/…` or `docs/…`. Never commit to `main`.

### 3. Decide before you build

Any foundational or policy-shaped choice gets an ADR in the **number reserved for your session** (see [README](README.md#reserved-numbers)). Owner or legal decisions are **asked**, not invented. Each kit lists them with a safe default to use if no answer has arrived.

### 4. Contract first (cross-repo work)

- **Backend sessions** change edge operations in this order:
  1. the owning service route (with permission check);
  2. `services/edge-gateway/src/domain/upstream-operations.ts`;
  3. `edge-operations.ts`;
  4. the controller in `src/adapters/http/`;
  5. `routes.ts`;
  6. `openapi/edge-v1.yaml`;
  7. a projection test under `test/`.

  This is the order of commit `c268f32` (admitAtGate).
- **Frontend sessions** consume an operation **after it merges**, in one commit:
  1. bump `EDGE_BACKEND_SHA` (`packages/api-client/src/paths.ts`) and `BACKEND_SHA` (`.github/workflows/ci.yml`);
  2. update the hand-authored `packages/contracts/openapi/*.yaml` (the pinned SHA in every document);
  3. run `pnpm --filter @usrp/contracts generate`, `verify`, and `drift -- --backend ../e-recruitment`;
  4. add the api-client `operations/`, `queries/` and `wire.ts` entries, plus the selfcheck.

  This is the order of commits `2c90f5d` and `4d21ba3`.
- **Working against an unmerged contract** is allowed only with intercepted specs labelled `CONTRACT-PENDING: SNN`. Such a PR cannot merge before the contract does.

### 5. Build with the test pyramid

| Layer | Where | Rule |
|---|---|---|
| Pure domain | `domain/*.ts` + node:test/vitest | Every decision function is pure and total; exhaustive over its union |
| Service proof | `services/<svc>/selfcheck/*.ts`, registered in `scripts/run-selfchecks.sh` | Runs against **real** infra; proves negative paths (cross-agency, wrong role, replay, forged input) |
| Edge projection | `services/edge-gateway/test/*.test.ts` | Response allowlist: nothing leaves that is not named |
| Frontend unit | `*.test.ts` beside the model | Pure mapping of wire → UI state; tested from **real wire bodies** |
| Mocked E2E | `apps/*/e2e/*.spec.ts` | Every manifest state; trilingual or `usrp_lang`-pinned selectors |
| **Live rehearsal** | `tools/rehearsal` scenario + `apps/applicant-portal/e2e/live-rehearsal.spec.ts` | Every user-facing capability is driven on the **real** stack. Mocks proved W1-09 "green" while the backend refused it. |

### 6. Self-review before anyone else sees it

- Run `/code-review high` on the diff. Run `/security-review` for any session that touches authentication, permissions, biometrics, secrets, CI or infrastructure.
- Fix the findings, or answer each one in the PR body.
- Check the repository invariants (frontend `AGENTS.md` §2; handbook §8 and §12):
  - one origin only;
  - no secrets, raw National IDs or biometric frames in code, logs, events or responses;
  - no generic status PATCH;
  - no automatic write retries;
  - agency comes from the session only;
  - ADS composition ladder;
  - tokens only, 48 px targets.

### 7. Prove locally, then in CI

```bash
# backend
pnpm build && pnpm typecheck && pnpm lint:count            # lint must stay 0
pnpm verify                                                 # all proofs, live infra (or the subset the kit names)
# frontend
pnpm turbo run typecheck lint test build --force            # uncached: check "Cached: 0" and the task counts
pnpm verify:rules && pnpm verify:hygiene && pnpm surface:verify && pnpm check:boundaries
CI=1 pnpm test:e2e                                          # CI's own config, production build
# live
pnpm rehearse && USRP_LIVE=1 npx playwright test e2e/live-rehearsal.spec.ts   # in apps/applicant-portal
```

Distrust exit codes:
- turbo cache hits (`FULL TURBO`) are not evidence;
- empty `node_modules/.bin` shims have produced fake greens (2026-10-15);
- a scanner that cannot run must say so, not report findings (fixed 2026-10-16).

**Done means CI is green on the PR head.** Local green is necessary, never sufficient.

### 8. Record

- Update the capability map row(s) in the same PR.
- Tick the session in [README](README.md#status-board) with its PR link.
- Add or extend a rehearsal scenario step.

### 9. Hand off

The PR body ends with the hand-off note (template below). The next session starts by reading it.

## Process hygiene (the machine is shared with a developer)

- Start your own servers detached with `setsid … &`, and stop them by **session ID** when done. Turbo gives each task its own process group, so killing one group is not enough.
- Before starting a server, check who owns the port: `ss -ltnp | grep :<port>`. **Never kill a process with a TTY.** That is the developer's own `pnpm dev` in their editor.
- Never edit or delete untracked local files you did not create (`.env` files are the developer's).
- External services can fail (GitHub API resets, Trivy DB downloads timing out). Report such a failure as *could not verify*, never as a pass or a finding.

## Code standards (non-negotiable; enforced by CI where possible)

**Backend** (handbook §12):
- TypeScript strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`;
- ESM with `.js` specifiers; hexagonal (domain → ports → application → adapters);
- business outcomes are return values, only bad input and infrastructure faults throw;
- every write is idempotent or explicitly not retried;
- new tables get FORCE'd RLS and append-only triggers where they hold evidence;
- PII-free events.

**Frontend** (`AGENTS.md`):
- feature slices never import each other;
- ADS first;
- `@compiled`/`@atlaskit/css` styles;
- tokens only, no hex;
- every new string in en, rw and fr;
- every route has a surface manifest with its readiness rung.

**Both:** Conventional Commits, one logical change per commit, with the attribution trailer.

## PR template (S00 installs it in both repos as `.github/pull_request_template.md`)

```markdown
## Session
SNN — <title> · kit: docs/program/sessions/SNN-*.md

## What and why
<the change, and the problem it solves>

## Evidence
- [ ] Local gates uncached (paste task counts)
- [ ] Proofs / tests added (list)
- [ ] Live rehearsal step: <scenario/step> passing
- [ ] CI green on this head
- [ ] /code-review high run; findings fixed or answered below
- [ ] /security-review run (auth, permissions, biometrics, secrets, CI, infra)

## Contract
- [ ] No edge contract change   - [ ] Edge contract change (backend) — operations: …
- [ ] Re-pin to backend <sha> (frontend)

## Docs
- [ ] Capability map updated   - [ ] ADR-<n> added   - [ ] Programme status ticked

## Hand-off
- Now possible: …
- Not done / deferred: …
- Risks / owner decisions pending: …
```
