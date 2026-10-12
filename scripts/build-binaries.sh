#!/usr/bin/env bash
# Builds standalone hub executables (Bun runtime + hub + web/ embedded; nothing else to install) into
# dist/opencode-voice-hub-<os>-<arch>[.exe] and writes dist/SHA256SUMS.
#
#   scripts/build-binaries.sh                      # every target
#   scripts/build-binaries.sh darwin-arm64 linux-x64
#
# Needs bun and the npm dependencies (npm install). Cross-compiling downloads the Bun runtime for each
# target once (cached by bun).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALL=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)
TARGETS=("$@")
[[ ${#TARGETS[@]} -gt 0 ]] || TARGETS=("${ALL[@]}")

bun scripts/gen-web-entry.ts
mkdir -p dist

for target in "${TARGETS[@]}"; do
  case " ${ALL[*]} " in
    *" $target "*) ;;
    *) echo "unknown target: $target (one of: ${ALL[*]})" >&2; exit 2 ;;
  esac
  out="dist/opencode-voice-hub-$target"
  [[ $target == windows-* ]] && out="$out.exe"
  echo "==> $out"
  bun build --compile --minify --sourcemap --target="bun-$target" .build/hub.ts --outfile "$out"
done

cd dist
files=(opencode-voice-hub-*)
if command -v sha256sum >/dev/null; then
  sha256sum "${files[@]}" > SHA256SUMS
else
  shasum -a 256 "${files[@]}" > SHA256SUMS
fi
cat SHA256SUMS
