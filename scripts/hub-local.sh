#!/usr/bin/env bash
# Run Hub on this machine in the foreground (Ctrl-C stops it).
# Configured by ~/.config/hub/hub.json (or $HUB_CONFIG); HUB_* env vars win over it. The legacy names
# ($VOICE_HUB_CONFIG, VOICE_*) still work, and on first start the hub copies a legacy hub.json and state
# directory from ~/.config/opencode-hub and ~/.local/state/opencode-hub (else the opencode-voice ones).
# Default address http://127.0.0.1:4097, state in ~/.local/state/hub. See README → Local only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG="${HUB_CONFIG:-${VOICE_HUB_CONFIG:-$BASE/hub/hub.json}}"
LEGACY=""
for dir in opencode-hub opencode-voice; do
  if [[ -f "$BASE/$dir/hub.json" ]]; then LEGACY="$BASE/$dir/hub.json"; break; fi
done
if [[ -f "$CONFIG" ]]; then
  perms=$(stat -f %Lp "$CONFIG" 2>/dev/null || stat -c %a "$CONFIG")
  if [[ "$perms" != "600" && "$perms" != "400" ]]; then
    echo "warning: $CONFIG has mode $perms; API keys in it are ignored until you run: chmod 600 $CONFIG" >&2
  fi
elif [[ -z "${HUB_CONFIG:-}${VOICE_HUB_CONFIG:-}" && -n "$LEGACY" ]]; then
  echo "note: $CONFIG not found; the hub copies $LEGACY there on start" >&2
else
  echo "note: $CONFIG not found; using env vars and defaults" >&2
fi
BUN="${BUN:-$(command -v bun || true)}"
[[ -n "$BUN" ]] || BUN="$HOME/.bun/bin/bun"
cd "$ROOT"
exec "$BUN" bin/hub.ts "$@"
