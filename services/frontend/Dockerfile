# =============================================================================
# Null AI app image: the built app, served by nginx, which also proxies /api to the backend.
# =============================================================================
# Built from the repository root by the root docker-compose.yml:
#   docker build -f services/frontend/Dockerfile .
# =============================================================================

# --- Pruner: only the app workspace and the packages it uses ---
FROM node:22-slim AS pruner
RUN npm install -g turbo@2.10.2
WORKDIR /app
COPY . .
RUN turbo prune frontend-service --docker

# --- Builder ---
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci
COPY --from=pruner /app/out/full/ .
RUN cd packages/contracts && npm run build

# Empty: the app calls the API on its own origin (/api), which nginx proxies to the backend.
ENV VITE_API_BASE_URL=
RUN cd services/frontend && npm run build

# --- Runtime ---
FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236
COPY services/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/services/frontend/dist /usr/share/nginx/html
EXPOSE 8080
