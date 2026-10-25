# The hub sandbox image: what an OpenShell sandbox of `hub node` runs (packages/runtime-openshell; spike report
# gut64rwq). Build it with build.ts, never from the repository root: the context is a staged directory holding
#   bin/opencode            the pinned Linux OpenCode build (npm @opencode/cli-linux-<arch>@<OPENCODE_VERSION>)
#   bin/hub-sandbox-start   bin/hub-sandbox-entry   (entry.sh, start.sh)
#   lib/hub/node_modules/@huynle/hub               the hub plugin, installed from this repository's package
#   bun packages/runtime-openshell/image/build.ts image [--arch arm64|x64] [--tag NAME:TAG]
# The runtime creates the sandbox with no main command (it stays Ready) and execs /usr/local/bin/hub-sandbox-start,
# which waits for /sandbox/.hub/config.json and .hub/ready and runs `opencode serve --service`. OpenShell runs it as
# its own user (HOME=/sandbox, the only writable place with /tmp) and injects its proxy CA through the Node and
# OpenSSL CA environment variables, which nothing here may set or clear.
FROM debian:bookworm-slim

ARG HUB_VERSION=dev
ARG OPENCODE_VERSION=dev
LABEL org.opencontainers.image.title="hub-sandbox" \
      org.opencontainers.image.description="Hub sandbox: OpenCode with the hub plugin, for hub node's OpenShell runtime" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/huynle/hub" \
      org.opencontainers.image.version="${HUB_VERSION}" \
      io.github.huynle.hub.opencode-version="${OPENCODE_VERSION}"

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git bash ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/*

COPY bin/ /usr/local/bin/
COPY lib/hub/ /usr/local/lib/hub/
RUN chmod 0755 /usr/local/bin/opencode /usr/local/bin/hub-sandbox-start /usr/local/bin/hub-sandbox-entry \
 && chmod -R a+rX /usr/local/lib/hub

# The harness stays offline but for the hub and its providers (decision lk6gn3u7 §7); the entry script sets them
# again, so the bootstrap fallback on another image gets them too.
ENV OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    HUB_SANDBOX_IMAGE=${HUB_VERSION}
