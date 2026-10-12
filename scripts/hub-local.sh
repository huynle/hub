#!/usr/bin/env bash
# Run the voice hub on this machine in the foreground (Ctrl-C stops it).
# Configured by ~/.config/opencode-voice/hub.json (or $VOICE_HUB_CONFIG); VOICE_* env vars win over it.
# Default address http://127.0.0.1:4097, state in ~/.local/state/opencode-voice. See README → Local only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${VOICE_HUB_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode-voice/hub.json}"
if [[ -f "$CONFIG" ]]; then
  perms=$(stat -f %Lp "$CONFIG" 2>/dev/null || stat -c %a "$CONFIG")
  if [[ "$perms" != "600" && "$perms" != "400" ]]; then
    echo "warning: $CONFIG has mode $perms; API keys in it are ignored until you run: chmod 600 $CONFIG" >&2
  fi
else
  echo "note: $CONFIG not found; using env vars and defaults" >&2
fi
BUN="${BUN:-$(command -v bun || true)}"
[[ -n "$BUN" ]] || BUN="$HOME/.bun/bin/bun"
cd "$ROOT"
exec "$BUN" bin/hub.ts "$@"
