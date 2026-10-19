# syntax=docker/dockerfile:1
# ══════════════════════════════════════════════════════════════════
# audit-service — production image (ADR-038)
#
# Built from the REPOSITORY ROOT (the workspace protocol resolves every
# @usrp/* dependency from the monorepo):
#   docker build -f services/audit-service/Dockerfile \
#     --build-arg USRP_BUILD_SHA=$(git rev-parse HEAD) -t usrp-audit-service:dev .
#
# Every service Dockerfile is the same template; the deployment-hygiene proof
# (packages/shared-config/selfcheck/verify-deployment-hygiene.ts) pins the
# parts that matter: digest-pinned bases, EXPOSE = PORT = .env.example,
# HEALTHCHECK on /ready, build facts for GET /version, non-root, exec-form CMD.
# Bump the base digest in all twelve files at once:
#   docker buildx imagetools inspect node:24-bookworm-slim
# ══════════════════════════════════════════════════════════════════

# ── Build: compile the service and its workspace dependencies ──────
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable
WORKDIR /repo

# Manifests first so a source-only change does not invalidate the install layer.
# patches/ is load-bearing: package.json patches kafkajs, and the original
# images never built because the patch file was missing from the context.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY packages ./packages
COPY services/audit-service ./services/audit-service

# The pnpm store is a BuildKit cache mount: shared across the twelve builds on
# one builder, never part of a layer.
RUN --mount=type=cache,id=usrp-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @usrp/audit-service...
RUN pnpm --filter @usrp/audit-service... run build

# Production closure only: reinstall without devDependencies (tsx, typescript,
# drizzle-kit never reach the runtime), then drop everything that is not
# compiled output — sources, tests, selfchecks and their dev fixtures.
RUN --mount=type=cache,id=usrp-pnpm-store,target=/pnpm/store \
    rm -rf node_modules packages/*/node_modules services/*/node_modules \
 && pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --package-import-method=copy --filter @usrp/audit-service... \
 && find packages services -mindepth 2 -maxdepth 2 \
      \( -name src -o -name test -o -name selfcheck -o -name scripts -o -name '*.tsbuildinfo' \) \
      -exec rm -rf {} + \
 && rm -rf patches turbo.json tsconfig.base.json

# ── Runtime ────────────────────────────────────────────────────────
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
# A service needs node and nothing else. npm, npx, corepack and yarn (with
# their bundled dependency trees) are most of the base image's scanner surface
# and are never executed here, so they are removed, not merely unused.
# Debian security fixes land between base-image refreshes (perl-base was a
# fixable CRITICAL on the pinned digest), so the runtime takes them at build
# time; the Trivy gate then sees what actually ships.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log
ENV NODE_ENV=production
# The canonical port (.env.example PORT_AUDIT_SERVICE); PORT_AUDIT_SERVICE or PORT
# override it at runtime. Without it a bare `docker run` would listen on 3000
# while EXPOSE advertised 4010.
ENV PORT=4010
WORKDIR /repo
COPY --from=build /repo /repo

# Build facts for GET /version (ADR-038). CI passes the commit, ref and instant.
ARG USRP_BUILD_SHA=unknown
ARG USRP_BUILD_REF=unknown
ARG USRP_BUILD_TIME=unknown
ENV USRP_BUILD_SHA=$USRP_BUILD_SHA \
    USRP_BUILD_REF=$USRP_BUILD_REF \
    USRP_BUILD_TIME=$USRP_BUILD_TIME
LABEL org.opencontainers.image.title="usrp-audit-service" \
      org.opencontainers.image.source="https://github.com/Jackson-NSANZIMANA/e-recruitment" \
      org.opencontainers.image.revision=$USRP_BUILD_SHA \
      org.opencontainers.image.created=$USRP_BUILD_TIME \
      org.opencontainers.image.licenses="UNLICENSED"

EXPOSE 4010
# Readiness, not liveness: Compose `--wait` and `depends_on: service_healthy`
# should mean "serving", not "process exists". Orchestrators set their own probes.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT_AUDIT_SERVICE||process.env.PORT)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
USER node

WORKDIR /repo/services/audit-service
# Exec form: signals reach node directly, so SIGTERM runs the graceful
# shutdown in main() instead of being swallowed by a shell.
CMD ["node", "dist/main.js"]
