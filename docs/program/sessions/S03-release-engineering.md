# S03 — Release engineering

**Phase 1 · both repos (CI and image definitions) · depends on S00** · Branch `feat/s03-release` in each repo · Reserved: **ADR-038**, **ADR-FE-014**

## Why
CI proves the code but produces nothing deployable. No image is built, scanned, signed or published, the SPAs have no serving image, and nothing ties a running service back to the commit it came from. This session is gate G1 (baseline §15.1), and S07 deploys what it produces.

## What exists
| Fact | Source |
|---|---|
| 12 service Dockerfiles: multi-stage, `node:24-bookworm-slim`, `pnpm install --prod --filter <svc>...`, `USER node`, exec-form CMD | `services/*/Dockerfile` |
| A deployment-hygiene proof already checks EXPOSE ↔ port map, non-root and exec-form CMD | `pnpm verify` |
| Backend CI jobs: typecheck, lint, proofs, Trivy (fs) | `.github/workflows/ci-backend.yml` |
| Frontend CI: build → `frontend-production-dist` artefact; Trivy action passes on GitHub runners (it cannot complete locally right now) | `.github/workflows/ci.yml` |

## Design (ADR-038 / ADR-FE-014)
- **Images:**
  - one per service (12);
  - one per SPA (applicant-portal, officer-console, field-station once S02 lands).

  SPA image: a static server (recommend Caddy or nginx-unprivileged; ADR decides) that serves `dist/` with SPA fallback that **never serves index.html for `/edge/**`**, and sets these headers:
  - strict CSP (self, no inline scripts; fonts self-hosted already);
  - HSTS;
  - `X-Content-Type-Options`;
  - `Referrer-Policy: no-referrer`;
  - `Permissions-Policy` (camera only on field-station, for B2);
  - `Cache-Control: no-cache` on `index.html`, `sw.js` and `manifest`.
- **Supply chain**, per image:
  - pinned base image digests;
  - Trivy image scan (CRITICAL/HIGH blocking, registered exceptions only);
  - SBOM (CycloneDX, via syft or Trivy);
  - `cosign` signature (keyless OIDC in GitHub Actions) and SBOM attestation.
- **Registry:** GHCR for now (S07 may mirror into the national registry). Tag `<sha>` on every main build; tag `vX.Y.Z` on a release tag. Never `latest` in deployment.
- **Version attestation:** each service exposes `GET /version` (build SHA, contract version, policy hash where relevant), via shared-http, append-only. Each SPA embeds its SHA in a `<meta>` tag and in `/version.json`. S11a dashboards version skew.
- **Release evidence bundle:** a tagged release produces `release-<tag>.json`, extending S00's per-commit bundle with image digests, SBOM references, signatures, test/proof counts (skips separated) and the peer repo SHA.

## Read first
`services/*/Dockerfile`, both CI workflows, `scripts/` deployment-hygiene proof, `packages/shared-http/src` (where `/health` and `/ready` live), baseline §15.1, S00's evidence-bundle job.

## Preconditions
```bash
docker version && docker buildx version
gh run list --branch main --limit 1            # both repos green
```

## Owns
- `.github/workflows/*` (append new jobs)
- `services/*/Dockerfile`
- `apps/*/Dockerfile` (new)
- `infrastructure/images/**` (new: static-server config)
- `/version` in shared-http (append-only)
- ADR-038 and ADR-FE-014

## Work plan
1. ADRs (static-server choice, registry, signing, tag policy).
2. Pin base images by digest. Add `HEALTHCHECK`. Keep the existing deployment-hygiene proof green and extend it to `/version`.
3. SPA Dockerfiles and server config. Headers test: a script that boots each image and asserts the headers, the SPA fallback, and that `/edge/*` returns 404 or proxies, never index.html.
4. CI: `images` job (matrix over 12 + 3, buildx with cache) → scan → SBOM → sign → push on `main` and tags only (PRs build and scan without pushing).
5. Release workflow on `v*` tags → evidence bundle → GitHub Release with the bundle attached.
6. Local proof:
   1. `docker compose` a mini stack from the **built images** (not `pnpm dev`) against tier1/tier2 infrastructure;
   2. `pnpm rehearse`;
   3. the live spec against the containerised apps.

   This is the first time the platform runs from its images.

## Quality bar
- Every image under its size budget (record it)
- Trivy clean or registered exceptions
- `cosign verify` succeeds
- Headers test passes
- Rehearsal journey passes on the containerised stack

## Exit gate
- [ ] A `main` push publishes 15 signed, scanned images with SBOMs.
- [ ] A `v0.1.0-rc1` tag produces a GitHub Release with the evidence bundle.
- [ ] Rehearsal journey green against the images (documented command).
- [ ] CI green; ADRs merged; status board updated; S07 and S11a unblocked.

## Owner decisions (ask; default if no answer)
| Decision | Default |
|---|---|
| Registry | GHCR now; national registry mirror later |
| Static server | Caddy (simple, automatic headers) unless ops prefers nginx |

## Session starter
```text
You are the release and platform engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Repos: ~/Documents/projects/e-recruitment-software/e-recruitment and .../e-recruitment-ui.

This is session S03 — Release engineering. Read your kit e-recruitment/docs/program/sessions/S03-release-engineering.md, then docs/program/README.md and quality-workflow.md, and follow them.

Goal: CI builds, scans (Trivy), SBOMs (CycloneDX) and cosign-signs 12 service images and the SPA images (hardened static server with CSP/HSTS, SPA fallback that never swallows /edge), publishes them on main and tags, exposes /version on every service and SPA, and produces a release evidence bundle on v* tags — proven by running the rehearsal journey against a stack started from the built images.

Use ADR-038 and ADR-FE-014 only. Run /security-review. Done = CI green on both PR heads, a release-candidate tag with its evidence bundle, status board updated, hand-off note.
```
