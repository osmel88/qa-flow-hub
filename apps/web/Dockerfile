# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Web image. The React application is a static bundle, so the runtime stage is
# just nginx serving files and forwarding /api and /health to the API service.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

COPY packages/config packages/config
COPY packages/shared packages/shared
COPY packages/ui packages/ui
COPY apps/web apps/web
RUN npm run build -w @qa-flow-hub/shared && npm run build -w @qa-flow-hub/web

# --- runtime ---------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
