# syntax=docker/dockerfile:1.7
# One Dockerfile, three runtime targets:
#   docker build --target api    -t vela-api .
#   docker build --target worker -t vela-worker .
#   docker build --target stream -t vela-stream .

ARG NODE_VERSION=22

# ---------- build everything ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json tsup.base.mjs ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/player/package.json packages/player/
COPY packages/sdk-node/package.json packages/sdk-node/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/stream/package.json apps/stream/
COPY apps/dashboard/package.json apps/dashboard/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @vela/player build \
 && pnpm --filter @vela/dashboard build \
 && pnpm --filter @vela/api build \
 && pnpm --filter @vela/worker build \
 && pnpm --filter @vela/stream build

# ---------- shared runtime base ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd -r vela && useradd -r -g vela -d /app vela

# ---------- API (+ dashboard) ----------
FROM runtime AS api
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/packages/db/migrations ./migrations
COPY --from=build /src/apps/dashboard/dist ./dashboard
ENV MIGRATIONS_DIR=/app/migrations DASHBOARD_DIST=/app/dashboard API_PORT=4000
USER vela
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ---------- media tools (ffmpeg + Shaka Packager) ----------
FROM runtime AS media
ARG TARGETARCH
ARG SHAKA_PACKAGER_VERSION=v3.4.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && ARCH=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64) \
 && curl -fsSL -o /usr/local/bin/packager "https://github.com/shaka-project/shaka-packager/releases/download/${SHAKA_PACKAGER_VERSION}/packager-linux-${ARCH}" \
 && chmod +x /usr/local/bin/packager \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# ---------- worker ----------
FROM media AS worker
COPY --from=build /src/apps/worker/dist ./dist
ENV WORK_DIR=/work RECORDINGS_DIR=/recordings
RUN mkdir -p /work /recordings && chown vela:vela /work /recordings
USER vela
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ---------- stream (playback / delivery) ----------
FROM media AS stream
COPY --from=build /src/apps/stream/dist ./dist
COPY --from=build /src/packages/player/dist ./player
ENV PLAYER_DIST=/app/player STREAM_PORT=4100
USER vela
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s CMD node -e "fetch('http://localhost:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
