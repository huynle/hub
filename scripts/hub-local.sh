#!/usr/bin/env bash
# Run OpenCode Hub on this machine in the foreground (Ctrl-C stops it).
# Configured by ~/.config/opencode-hub/hub.json (or $HUB_CONFIG); HUB_* env vars win over it. The legacy
# opencode-voice names ($VOICE_HUB_CONFIG, VOICE_*) still work, and the hub copies a legacy
# ~/.config/opencode-voice/hub.json and ~/.local/state/opencode-voice on first start.
# Default address http://127.0.0.1:4097, state in ~/.local/state/opencode-hub. See README → Local only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${HUB_CONFIG:-${VOICE_HUB_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode-hub/hub.json}}"
LEGACY="${XDG_CONFIG_HOME:-$HOME/.config}/opencode-voice/hub.json"
if [[ -f "$CONFIG" ]]; then
  perms=$(stat -f %Lp "$CONFIG" 2>/dev/null || stat -c %a "$CONFIG")
  if [[ "$perms" != "600" && "$perms" != "400" ]]; then
    echo "warning: $CONFIG has mode $perms; API keys in it are ignored until you run: chmod 600 $CONFIG" >&2
  fi
elif [[ -z "${HUB_CONFIG:-}${VOICE_HUB_CONFIG:-}" && -f "$LEGACY" ]]; then
  echo "note: $CONFIG not found; the hub copies $LEGACY there on start" >&2
else
  echo "note: $CONFIG not found; using env vars and defaults" >&2
fi
BUN="${BUN:-$(command -v bun || true)}"
[[ -n "$BUN" ]] || BUN="$HOME/.bun/bin/bun"
cd "$ROOT"
exec "$BUN" bin/hub.ts "$@"
