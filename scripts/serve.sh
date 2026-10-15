#!/usr/bin/env bash
# Start a private foreground OpenCode server for test-project/, separate from the
# shared background service. Logs (including the one-time password) go to $HUB_SERVE_LOG (legacy $VOICE_SERVE_LOG).
set -euo pipefail
cd "$(dirname "$0")/../test-project"
LOG="${HUB_SERVE_LOG:-${VOICE_SERVE_LOG:-${TMPDIR:-/tmp}/hub-serve.log}}"
PORT="${HUB_SERVE_PORT:-${VOICE_SERVE_PORT:-4199}}"
exec opencode serve --hostname 127.0.0.1 --port "$PORT" --print-logs --log-level "${HUB_LOG_LEVEL:-${VOICE_LOG_LEVEL:-info}}" >"$LOG" 2>&1
