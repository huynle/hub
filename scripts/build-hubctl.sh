#!/usr/bin/env bash
# Builds standalone hubctl executables (Bun runtime + the hub CLI + its service templates and trust root embedded;
# nothing else to install) into dist/hubctl-<target> for the supported targets, and writes dist/HUBCTL_SHA256SUMS.
# This is separate from scripts/build-binaries.sh, which builds the central hub server.
#
#   scripts/build-hubctl.sh                          # every supported target (dev build if no trust root)
#   scripts/build-hubctl.sh linux-x64                # one target
#   scripts/build-hubctl.sh --require-trust-root …   # release build: refuse without a trust root
#
# Needs bun and the npm dependencies (npm install). Cross-compiling downloads the Bun runtime per target once.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bun scripts/hubctl-release.ts build "$@"

cd dist
files=(hubctl-*)
if command -v sha256sum >/dev/null; then
  sha256sum "${files[@]}" > HUBCTL_SHA256SUMS
else
  shasum -a 256 "${files[@]}" > HUBCTL_SHA256SUMS
fi
cat HUBCTL_SHA256SUMS
