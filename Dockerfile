# syntax=docker/dockerfile:1

# The public server's image: the server package and its runtime dependencies, built from the workspace, on a small
# Node, run as an unprivileged user. Coolify builds it from this file on a deploy; CI builds it too, and smoke-tests it.
#
#   build:   pnpm fetch (the lockfile alone, so the layer is cached) ─▶ install ─▶ tsc -b ─▶ pnpm deploy --prod /out
#   runtime: /out as /app, user `node`, GET /healthz as the health check, node dist/public-main.js
#
# The settings come from the environment at run time (packages/server/src/public.ts): DATABASE_URL, ALLOWED_LOGINS,
# GITHUB_CLIENT_SECRET, and optionally PORT and GITHUB_CLIENT_ID. None is baked in.

FROM node:22-alpine AS build
RUN npm install --global pnpm@12.9.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build
# The server with only its production dependencies, the workspace packages it uses copied in, built.
RUN pnpm --filter @pathofdev/server deploy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
# Owned by root, so the server can't change its own code.
COPY --from=build /out ./
USER node
EXPOSE 3000
# busybox wget fails on any answer but a 2xx, so a 503 (the database not answering) marks the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "dist/public-main.js"]
