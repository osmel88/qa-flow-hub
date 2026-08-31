# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# API image. Multi-stage: dependencies and the TypeScript compiler stay in the
# build stage, so the runtime image ships only production dependencies and the
# compiled output.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS base
ENV NODE_ENV=development
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# --- dependencies ----------------------------------------------------------
FROM base AS deps
# Only manifests are copied first: Docker can then reuse the install layer for
# every build that does not change a dependency.
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# --- build -----------------------------------------------------------------
FROM deps AS build
COPY packages/config packages/config
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY eslint.config.js prettier.config.js ./
RUN npm run build -w @qa-flow-hub/shared \
  && npx prisma generate --schema apps/api/prisma/schema.prisma \
  && npm run build -w @qa-flow-hub/api

# --- runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client node_modules/@prisma/client
COPY apps/api/prisma apps/api/prisma

# Never run as root: a container escape should not start with uid 0.
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
