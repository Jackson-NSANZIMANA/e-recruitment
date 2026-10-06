# ══════════════════════════════════════════════════════════════════
# eligibility-service — production image
# ══════════════════════════════════════════════════════════════════
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/eligibility-service ./services/eligibility-service

RUN pnpm install --frozen-lockfile --filter @usrp/eligibility-service...
RUN pnpm --filter @usrp/eligibility-service... run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services/eligibility-service ./services/eligibility-service

RUN pnpm install --frozen-lockfile --prod --filter @usrp/eligibility-service... \
 && pnpm store prune \
 && rm -rf /pnpm/.cache

EXPOSE 4002
USER node

WORKDIR /repo/services/eligibility-service
CMD ["node", "dist/main.js"]
