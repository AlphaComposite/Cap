# syntax=docker.io/docker/dockerfile:1

FROM oven/bun:1.4.0-alpine AS bun

FROM node:24-alpine AS base

# Install from dependency manifests only so the multi-GB bun install layer is
# reused until bun.lock or a workspace package.json changes, instead of being
# rebuilt and re-cached on every source edit.
FROM base AS manifests
RUN --mount=type=bind,target=/src \
	mkdir -p /manifests && cd /src && \
	ls package.json bun.lock bunfig.toml apps/*/package.json packages/*/package.json infra/package.json \
	| tar -cf - -T - | tar -xf - -C /manifests

FROM base AS builder
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=manifests /manifests/ ./

RUN --mount=type=cache,id=bun-1.4.0,target=/root/.bun/install/cache --mount=type=secret,id=build_env,target=/app/.env bun install --frozen-lockfile

COPY . .

ARG NEXT_PUBLIC_DOCKER_BUILD=true
ENV NEXT_PUBLIC_WEB_URL=http://localhost:3000

RUN --mount=type=secret,id=build_env,target=/app/.env --mount=type=secret,id=build_env,target=/app/apps/web/.env bun run build:web


# 3. Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001


# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/packages/database/migrations ./apps/web/migrations
RUN rm -f /app/.env /app/apps/web/.env


USER nextjs

EXPOSE 3000

CMD HOSTNAME="0.0.0.0" node apps/web/server.js
