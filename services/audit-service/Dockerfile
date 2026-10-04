# ══════════════════════════════════════════════════════════════════
# audit-service — production image
# ══════════════════════════════════════════════════════════════════
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/audit-service ./services/audit-service

RUN pnpm install --frozen-lockfile --filter @usrp/audit-service...
RUN pnpm --filter @usrp/audit-service... run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services/audit-service ./services/audit-service

RUN pnpm install --frozen-lockfile --prod --filter @usrp/audit-service... \
 && pnpm store prune \
 && rm -rf /pnpm/.cache

EXPOSE 4010
USER node

WORKDIR /repo/services/audit-service
CMD ["node", "dist/main.js"]
