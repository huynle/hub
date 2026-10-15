#!/usr/bin/env bash
# Builds standalone hub executables (Bun runtime + hub + the built web app embedded; nothing else to install) into
# dist/opencode-hub-<os>-<arch>[.exe] and writes dist/SHA256SUMS.
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

npx --no-install vite build --config web/vite.config.ts
bun scripts/gen-web-entry.ts
mkdir -p dist

for target in "${TARGETS[@]}"; do
  case " ${ALL[*]} " in
    *" $target "*) ;;
    *) echo "unknown target: $target (one of: ${ALL[*]})" >&2; exit 2 ;;
  esac
  out="dist/opencode-hub-$target"
  [[ $target == windows-* ]] && out="$out.exe"
  echo "==> $out"
  bun build --compile --minify --sourcemap --target="bun-$target" .build/hub.ts --outfile "$out"
done

cd dist
files=(opencode-hub-*)
if command -v sha256sum >/dev/null; then
  sha256sum "${files[@]}" > SHA256SUMS
else
  shasum -a 256 "${files[@]}" > SHA256SUMS
fi
cat SHA256SUMS
