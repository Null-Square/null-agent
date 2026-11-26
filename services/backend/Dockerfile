# =============================================================================
# Null AI backend image
# =============================================================================
# Built from the repository root by the root docker-compose.yml:
#   docker build -f services/backend/Dockerfile .
#
# Debian slim, for the Chromium that renders PDF reports (the agent's browser runs in its sandbox).
# =============================================================================

# --- Pruner: only the backend workspace and what it depends on ---
FROM node:22-slim AS pruner
RUN npm install -g turbo@2.10.2
WORKDIR /app
COPY . .
RUN turbo prune backend-service --docker

# --- Base ---
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- Builder ---
FROM base AS builder
WORKDIR /app

COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci

COPY --from=pruner /app/out/full/ .

RUN cd packages/contracts && npm run build

WORKDIR /app/services/backend
RUN npm run skills:runtime-snapshot:write
RUN npm run build

# Evaluation fixtures, expected outcomes, and generated reports are build-time
# verification inputs only. They must not ship in the runtime image.
RUN find ./config/skills -type d -name fixtures -prune -exec rm -rf '{}' '+' \
    && rm -rf ./config/skills/evaluation

# --- Runtime ---
FROM base AS production
ENV NODE_ENV=production
WORKDIR /app

# Chromium for PDF reports; git, because code review clones a scope's git URL.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    git \
    && rm -rf /var/lib/apt/lists/*

# The Docker CLI (a static binary) starts each sandbox as a sibling container through the socket
# the compose file mounts.
COPY --from=docker:29-cli@sha256:4e60c31615e83523afbb59773b25d055c0da9edcd5f80a4c6a6eebad49de1a25 /usr/local/bin/docker /usr/local/bin/docker

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Production dependencies only (hoisted at /app/node_modules).
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci --omit=dev

COPY --from=builder /app/services/backend/dist ./services/backend/dist
COPY --from=builder /app/services/backend/drizzle ./services/backend/drizzle

# Runtime config depends on Markdown assets. Copy the build-stage projection,
# which has evaluation ground truth and generated reports removed.
COPY --from=builder /app/services/backend/config ./services/backend/config
COPY services/backend/templates ./services/backend/templates

# The sandbox tools manifest and version lock, read for the sandbox image's "Installed tools".
COPY services/sandbox/tools-manifest.json ./services/sandbox/tools-manifest.json
COPY services/sandbox/tool-versions.lock.json ./services/sandbox/tool-versions.lock.json

# npm ci links node_modules/@null-ai/contracts to packages/contracts.
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist

COPY services/backend/docker-entrypoint.sh ./services/backend/docker-entrypoint.sh
RUN sed -i 's/\r$//' ./services/backend/docker-entrypoint.sh \
    && chmod +x ./services/backend/docker-entrypoint.sh

WORKDIR /app/services/backend
RUN mkdir -p storage/workspaces storage/object-store

# Fail the image build early if required runtime prompt/skill assets are missing.
RUN test -f ./config/prompts/chat.md \
    && test -f ./config/prompts/planner.md \
    && test -f ./config/prompts/executor.md \
    && test -f ./config/skills/api-enumeration/SKILL.md \
    && test -f ./config/skills/api-enumeration/methodology.md \
    && test -f ./config/skills/runtime-catalog.snapshot.json \
    && test -f ./templates/validation-lead-prompt.md

# Exercise the exact runtime catalog path after evaluation fixtures have been
# removed and the final image filesystem has been assembled.
RUN node -e "const { SkillLoader } = require('./dist/domains/security-ops/skills/SkillLoader'); new SkillLoader().loadSkillCatalog().then((catalog) => { if (catalog.length === 0) throw new Error('runtime skill catalog is empty'); }).catch((error) => { console.error(error); process.exit(1); })"

# Root, on purpose: the process drives the Docker daemon through its socket (root on the daemon
# already), and the sandboxes it starts write the run workspace as root. A non-root user here would
# only lose the socket and the workspace files, not gain any isolation.
EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./docker-entrypoint.sh"]
