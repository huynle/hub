#!/usr/bin/env bash
# Call a private `opencode serve` started by scripts/serve.sh.
# Usage: scripts/oc.sh GET /api/info
#        scripts/oc.sh POST /api/session '{"location":{"directory":"..."}}'
set -euo pipefail
LOG="${VOICE_SERVE_LOG:-${TMPDIR:-/tmp}/voice-serve.log}"
PORT="${VOICE_SERVE_PORT:-4199}"
PW=$(grep -o 'server password .*' "$LOG" | tail -1 | awk '{print $3}')
method=$1 path=$2 body=${3:-}
args=(-s -m 120 -u "opencode:$PW" -X "$method" -H 'Content-Type: application/json')
[[ -n "$body" ]] && args+=(-d "$body")
curl "${args[@]}" "http://127.0.0.1:$PORT$path"
