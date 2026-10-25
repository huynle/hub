# Hub server. Runtime: Bun, the sources, and the hub's npm dependencies
# (web-push for notifications) at the versions pinned in package-lock.json. Published as
# ghcr.io/huynle/hub (see .github/workflows/release.yml; formerly opencode-hub and opencode-voice-hub).
#   docker build -t hub .
#   docker run -p 127.0.0.1:4097:4097 -v hub-data:/data -e HUB_PUBLIC_URL=https://hub.example.com \
#     -e OPENROUTER_API_KEY=... hub
# Legacy VOICE_* variables still work, except that the HUB_HOST/HUB_PORT/HUB_STATE_DIR defaults below
# win over VOICE_HOST/VOICE_PORT/VOICE_STATE_DIR: rename those overrides to HUB_*.
# The console (web/, Solid + Vite) is built in its own stage; the image ships only web/dist.
FROM node:22-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/cli/package.json ./packages/cli/
COPY packages/runtime-sdk/package.json ./packages/runtime-sdk/
COPY packages/node/package.json ./packages/node/
COPY packages/runtime-openshell/package.json ./packages/runtime-openshell/
COPY packages/spoke-sdk/package.json ./packages/spoke-sdk/
COPY packages/claude-code/package.json ./packages/claude-code/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY web ./web
RUN npx vite build --config web/vite.config.ts

FROM oven/bun:1.3-slim AS deps
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/cli/package.json ./packages/cli/
COPY packages/runtime-sdk/package.json ./packages/runtime-sdk/
COPY packages/node/package.json ./packages/node/
COPY packages/runtime-openshell/package.json ./packages/runtime-openshell/
COPY packages/spoke-sdk/package.json ./packages/spoke-sdk/
COPY packages/claude-code/package.json ./packages/claude-code/
# Bun migrates package-lock.json; --frozen-lockfile keeps the pinned versions.
RUN bun install --production --frozen-lockfile --ignore-scripts
COPY docker/hub-deps.ts ./
# Keep only what the hub loads at runtime (the @opencode/* packages are for the plugin).
RUN bun hub-deps.ts /deps web-push

FROM oven/bun:1.3-slim
LABEL org.opencontainers.image.title="hub" \
      org.opencontainers.image.description="Hub: a central hub for AI agent harnesses (OpenCode first): remote console, pairing, push and optional Voice" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/huynle/hub"
WORKDIR /app
COPY --from=deps /deps/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
# The protocol package (src/protocol.ts re-exports it by relative path).
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
# The SDK's pure envelope and address helpers (src/central/agent/envelope.ts and names.ts re-export them).
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/sdk/src ./packages/sdk/src
COPY --from=web /build/web/dist ./web/dist

ENV HUB_HOST=0.0.0.0 \
    HUB_PORT=4097 \
    HUB_STATE_DIR=/data \
    NODE_ENV=production

RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 4097

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.HUB_PORT || process.env.VOICE_PORT || 4097) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "bin/hub.ts"]
