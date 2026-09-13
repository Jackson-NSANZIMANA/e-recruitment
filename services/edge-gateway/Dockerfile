# ══════════════════════════════════════════════════════════════════
# edge-gateway — production image
#
# Built from the REPOSITORY ROOT, not this directory:
#   docker build -f services/edge-gateway/Dockerfile -t usrp/edge-gateway:<sha> .
#
# The workspace protocol means this package cannot be built in isolation — every
# @usrp/* dependency is resolved from the monorepo, so the build context is the
# repo and the install is workspace-wide.
#
# THREE POSTURES THAT MATTER FOR THIS PARTICULAR SERVICE, because it is the only
# process holding live officer credentials:
#
#   • non-root, read-only-friendly. It writes nothing to disk: no uploads, no
#     temp files, no local session state. Run it with a read-only root
#     filesystem.
#   • no secrets baked in. Every key arrives as an environment variable from a
#     Kubernetes Secret backed by HSM/KMS. `pnpm generate:env` and .env.example
#     are development-only artefacts and are NOT copied.
#   • production deps only in the final stage, so devDependencies (tsx,
#     typescript) are not part of the attack surface.
# ══════════════════════════════════════════════════════════════════
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# Manifests first so a source-only change does not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/edge-gateway ./services/edge-gateway

RUN pnpm install --frozen-lockfile --filter @usrp/edge-gateway...
RUN pnpm --filter @usrp/edge-gateway... run build

# ── Runtime ────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services/edge-gateway ./services/edge-gateway

RUN pnpm install --frozen-lockfile --prod --filter @usrp/edge-gateway... \
 && pnpm store prune \
 && rm -rf /pnpm/.cache

# The canonical edge port. Overridden by PORT_EDGE_GATEWAY / PORT at runtime.
EXPOSE 4021
USER node

# No shell form: signals reach node directly, so SIGTERM runs the graceful
# shutdown in main() instead of being swallowed by a shell.
WORKDIR /repo/services/edge-gateway
CMD ["node", "dist/main.js"]
