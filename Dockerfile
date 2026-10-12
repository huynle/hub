# Central voice server for opencode-voice. Runtime: Bun, the sources, and the hub's npm dependencies
# (web-push for notifications) at the versions pinned in package-lock.json. Published as
# ghcr.io/huynle/opencode-voice-hub (see .github/workflows/release.yml).
#   docker build -t opencode-voice-hub .
#   docker run -p 127.0.0.1:4097:4097 -v voice-data:/data -e VOICE_PUBLIC_URL=https://voice.example.com \
#     -e OPENROUTER_API_KEY=... opencode-voice-hub
FROM oven/bun:1.3-slim AS deps
WORKDIR /build
COPY package.json package-lock.json ./
# Bun migrates package-lock.json; --frozen-lockfile keeps the pinned versions.
RUN bun install --production --frozen-lockfile --ignore-scripts
COPY docker/hub-deps.ts ./
# Keep only what the hub loads at runtime (the @opencode/* packages are for the plugin).
RUN bun hub-deps.ts /deps web-push

FROM oven/bun:1.3-slim
LABEL org.opencontainers.image.title="opencode-voice-hub" \
      org.opencontainers.image.description="Voice server for opencode-voice: web app, pairing, speech and push for OpenCode sessions" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/huynle/opencode-voice"
WORKDIR /app
COPY --from=deps /deps/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web

ENV VOICE_HOST=0.0.0.0 \
    VOICE_PORT=4097 \
    VOICE_STATE_DIR=/data \
    NODE_ENV=production

RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 4097

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.VOICE_PORT || 4097) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "bin/hub.ts"]
