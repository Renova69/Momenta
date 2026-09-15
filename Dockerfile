# ====================================================================
# WedMoments Production Dockerfile
# Multi-stage build for optimized image size and security
# ====================================================================

# --------------------------------------------------------------------
# Stage 1: Build Frontend SPA & Verify Types
# --------------------------------------------------------------------
# Node major is pinned in .nvmrc, package.json engines and the CI workflow.
# CI fails if any of those four disagree (see "Node version pins agree"),
# which is what stops this image drifting back to a version nothing tests.
FROM node:24-alpine AS builder

WORKDIR /app

# Copy dependency specifications
COPY package*.json tsconfig*.json vite.config.ts ./

# Install dependencies (including devDependencies needed for build)
RUN npm ci

# Copy source code and assets. `npm run build` type-checks the server project as
# well as the SPA, so server/ and scripts/ must be present in this stage.
COPY src/ ./src/
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY shared/ ./shared/
COPY index.html ./
COPY tailwind.config.js postcss.config.js ./

# Build production Vite bundle into /app/dist
RUN npm run build

# --------------------------------------------------------------------
# Stage 2: Minimal Production Runtime
# --------------------------------------------------------------------
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=6501

# sharp does its work on libuv's threadpool, which defaults to 4 threads no
# matter how many cores the host has. Guest uploads are the CPU-bound path
# (decode + two resizes each), so a wedding's upload burst queues behind those
# four threads. Size it to the container's CPU allocation.
ENV UV_THREADPOOL_SIZE=16

# Install curl for container health check
RUN apk add --no-cache curl

# Copy dependency specifications
COPY package*.json ./

# Install production dependencies only + tsx runtime
RUN npm ci --omit=dev && npm install -g tsx

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy server code, shared modules, migrations and the maintenance scripts. The
# server imports shared/ at runtime and reads database/migrations on boot;
# scripts/ carries the operational tooling (retention sweep, storage recount and
# orphan cleanup) that is meant to be run against a live deployment.
COPY server/ ./server/
COPY shared/ ./shared/
COPY scripts/ ./scripts/
COPY database/ ./database/
COPY tsconfig*.json ./

# Both storage roots, created and owned before the process drops to `node`.
#
# LocalStorageAdapter's constructor mkdir's whichever of these does not exist
# (server/lib/storage.ts), and /app is owned by root while the process runs as
# node — so a root this step misses is an EACCES at module load, before any
# handler is reachable. Only `uploads` was created here, and QUARANTINE_DIR
# defaults to a *sibling* (`uploads-quarantine`, config.ts:177) rather than a
# child, so it was missed: the container could not start at all under
# STORAGE_PROVIDER=local, which is what docker-compose.yml defaults to.
#
# Not reachable under STORAGE_PROVIDER=r2, where createStorageAdapter returns
# the R2 adapter and never constructs the local one.
RUN mkdir -p uploads uploads-quarantine && chown -R node:node uploads uploads-quarantine

USER node

EXPOSE 6501

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:6501/api/health || exit 1

CMD ["tsx", "server/index.ts"]
