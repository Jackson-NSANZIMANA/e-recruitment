# ══════════════════════════════════════════════════════════════════
# application-service — production image
#
# Built from the REPOSITORY ROOT:
#   docker build -f services/application-service/Dockerfile -t usrp/application-service:<sha> .
# ══════════════════════════════════════════════════════════════════
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/application-service ./services/application-service

RUN pnpm install --frozen-lockfile --filter @usrp/application-service...
RUN pnpm --filter @usrp/application-service... run build

# ── Runtime ────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services/application-service ./services/application-service

RUN pnpm install --frozen-lockfile --prod --filter @usrp/application-service... \
 && pnpm store prune \
 && rm -rf /pnpm/.cache

EXPOSE 4006
USER node

WORKDIR /repo/services/application-service
CMD ["node", "dist/main.js"]
