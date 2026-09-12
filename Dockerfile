# ====================================================================
# WedMoments Production Dockerfile
# Multi-stage build for optimized image size and security
# ====================================================================

# --------------------------------------------------------------------
# Stage 1: Build Frontend SPA & Verify Types
# --------------------------------------------------------------------
FROM node:22-alpine AS builder

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
FROM node:22-alpine AS runner

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

# Create uploads directory with appropriate permissions
RUN mkdir -p uploads && chown -R node:node uploads

USER node

EXPOSE 6501

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:6501/api/health || exit 1

CMD ["tsx", "server/index.ts"]
