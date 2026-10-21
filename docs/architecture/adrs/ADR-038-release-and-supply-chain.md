# ADR-038 — Release and supply chain: images, scans, SBOMs, signatures, /version

**Status:** Accepted (2026-10-19, S03). **Frontend pair:** ADR-FE-014 (SPA
serving image). **Unblocks:** S07 (deployment), S11a (version-skew
dashboards). **Gate:** baseline §15.1 (G1).

## Context

CI proved the code and produced nothing deployable. The twelve service
Dockerfiles existed and the deployment-hygiene proof read them, but **no image
had ever been built from them**: `package.json` patches kafkajs, the patch file
was not in the build context, and `pnpm install` failed in every Dockerfile.
Nothing was scanned, signed or published, and nothing tied a running process
back to the commit it was built from.

## Owner decisions (asked, answered)

- **Registry: GHCR now** (`ghcr.io/jackson-nsanzimana/usrp-<service>`); a
  national-registry mirror later (S07).
- **SPA static server: Caddy** (ADR-FE-014).

## Decision

1. **Images.** One per service, from `services/<svc>/Dockerfile`, one template
   for all twelve:
   - bases pinned **by digest** (`node:24-bookworm-slim@sha256:…`);
   - `patches/` copied, pnpm store as a BuildKit cache mount;
   - the runtime holds the production dependency closure and compiled output
     only (no `src/`, tests, selfchecks or scripts); npm, npx, corepack and
     yarn are removed; Debian security updates are applied at build
     (`perl-base` was a fixable CRITICAL on the current digest);
   - `USER node`, exec-form `CMD`, `ENV PORT=<canonical port>`,
     `HEALTHCHECK` on `/ready`;
   - build facts `USRP_BUILD_SHA/REF/TIME` as build ARGs → ENV.

   The services run read-only with every capability dropped (proved by the
   rehearsal stack below). **Size budget: 300 MB per service image**; measured
   232–243 MB.
2. **Supply chain, per image** (`images` job, `ci-backend.yml`, matrix of 12):
   build and **load** (never push from the builder) → size budget → **Trivy**
   image scan, CRITICAL/HIGH fixable findings **blocking**, exceptions only in
   `infrastructure/images/trivy-exceptions.yaml` with a mandatory expiry →
   **CycloneDX SBOM** (Trivy) → on `main` only: push **the scanned bytes**,
   **cosign keyless** signature (GitHub OIDC; identity
   `…/ci-backend.yml@refs/heads/main`), SBOM **attestation**
   (`--type cyclonedx`), `cosign verify` and `verify-attestation` in the same
   job. PRs build and scan without pushing.
3. **Tags.** `<sha>` on every main build. `vX.Y.Z[-rcN]` on release, by
   **promotion**: `release.yml` points the version tag at the already-signed
   digest (`docker buildx imagetools create`), never a rebuild. A signature
   binds a digest, so the version tag inherits it. **Never `latest`.**
4. **`GET /version`** on every service, served by `@usrp/shared-http` beside
   `/health` and `/ready`:
   `{ service, build: { sha, ref, time }, contract?, policy? }`. Values from the
   environment are **validated, not echoed** (`unknown` otherwise). The edge
   adds `contract` (operation count + sha256 of the registry projection, the
   same hash the evidence bundle records, which now reads it from the edge
   itself) and `policy` (role → permission map hash). Not access-logged when
   healthy. The SPA counterpart is `/version.json` (ADR-FE-014).
5. **Release evidence.** `scripts/release-bundle.mjs` writes
   `release-<tag>.json` (`usrp-release/v1`): commit and CI run, peer commit,
   and per image digest, tags, size vs budget, SBOM summary and hash, Trivy
   counts, signature and attestation verification, plus S00's evidence for the
   commit (operations, proofs and unit tests with skips listed apart). In
   `release` mode it exits non-zero on any gap. It runs:
   - on every PR in `dry-run` mode (`release-bundle` job, no digests);
   - on `main` in `candidate` mode (signed digests);
   - in `release.yml` on a `v*` tag of a commit on `main`: fetch that commit's
     main CI artefacts → verify every signature and attestation against the
     main workflow identity → compose in `release` mode → promote → GitHub
     Release with the bundle and the SBOMs. The backend's peer is the frontend
     commit named in the tag annotation (`peer: <sha>`).
6. **Unit suites are a merge signal.** `Unit tests (every package)` runs every
   package's `test` script and the script regression tests (S00 left them
   only in the ungated evidence job). Branch protection is the owner's.

## Proof

- `pnpm verify` → the deployment-hygiene proof (222 checks): digest-pinned
  FROMs, `ENV PORT` = `EXPOSE` = `.env.example`, `HEALTHCHECK` on `/ready`,
  the three build ARGs, npm removal, `patches/`, `.dockerignore`, every
  service serving through `startHttpServer`, and a live `/version` round trip
  that refuses a malformed environment value. It goes red on an unpinned FROM.
- Unit: `packages/shared-http/test/version.test.ts`,
  `services/edge-gateway/test/version-fingerprints.test.ts`,
  `scripts/test/release-bundle.test.mjs`.
- **The platform runs from its images:** `infrastructure/images/rehearse.sh`
  (below) → `pnpm rehearse` → the frontend live journey, both personas green
  (2026-10-19).

## Running the platform from its images

```bash
pnpm infra:up                                   # tier1 + tier2 (shared; untouched)
for s in services/*/; do n=$(basename $s); docker build -f $s/Dockerfile -t usrp-s03/$n:dev .; done
# SPA images: see ADR-FE-014 (VITE_EDGE_URL=http://localhost:3510 / :3511)
infrastructure/images/rehearse.sh up            # own project, own DB, own Kafka
infrastructure/images/rehearse.sh rehearse      # pnpm rehearse via the officer SPA's /edge
# frontend, apps/applicant-portal:
USRP_LIVE=1 USRP_PORTAL_URL=http://localhost:3510 USRP_OFFICER_URL=http://localhost:3511 \
  USRP_DEV_SMS_INBOX=<backend>/.dev-sms-images/inbox.jsonl \
  npx playwright test -c e2e/playwright.config.ts --project desktop e2e/live-rehearsal.spec.ts
infrastructure/images/rehearse.sh down          # removes only this project and its DB
```

The stack runs the images with `NODE_ENV=development`, because the published
dev secrets it uses are exactly what the production guard refuses. Same
bytes, development configuration.

## Consequences

- S07 deploys `ghcr.io/jackson-nsanzimana/usrp-<svc>@sha256:…` and verifies
  each with
  `cosign verify --certificate-identity https://github.com/Jackson-NSANZIMANA/e-recruitment/.github/workflows/ci-backend.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com`.
  A mirror must copy signatures and attestations (`cosign copy`), not just
  images.
- A superseded `main` run (concurrency cancels in-progress runs) publishes no
  images for its commit; tag only a commit whose main CI run completed.
- `apt-get upgrade` at build trades bit-for-bit reproducibility for security
  fixes between base-image refreshes; the digest pins the starting point, the
  scan judges the result.
- New services must use the template; the hygiene proof enforces it.
