#!/usr/bin/env bash
# Builds standalone hubctl executables (Bun runtime + the hub CLI + its service templates and trust root embedded;
# nothing else to install) into dist/hubctl-<target> for the supported targets, and writes dist/HUBCTL_SHA256SUMS
# (both in --outdir instead, when given).
# This is separate from scripts/build-binaries.sh, which builds the central hub server.
#
#   scripts/build-hubctl.sh                          # every supported target (dev build if no trust root)
#   scripts/build-hubctl.sh linux-x64                # one target
#   scripts/build-hubctl.sh --require-trust-root …   # release build: refuse without a trust root
#   scripts/build-hubctl.sh --outdir /tmp/out …      # binaries and HUBCTL_SHA256SUMS in /tmp/out
#
# Needs bun and the npm dependencies (npm install). Cross-compiling downloads the Bun runtime per target once.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The release tool's --outdir (default dist), resolved like the release tool does: relative to the repository root.
outdir=dist
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = "--outdir" ] && [ $((i + 1)) -lt ${#args[@]} ]; then outdir="${args[i + 1]}"; fi
done

bun scripts/hubctl-release.ts build "$@"

cd "$outdir"
shopt -s nullglob
files=(hubctl-*)
if [ ${#files[@]} -eq 0 ]; then
  echo "no hubctl-* binaries in $PWD" >&2
  exit 1
fi
# Written aside and moved into place, so a failed checksum run never leaves a partial or empty HUBCTL_SHA256SUMS.
if command -v sha256sum >/dev/null; then
  sha256sum "${files[@]}" > HUBCTL_SHA256SUMS.tmp
else
  shasum -a 256 "${files[@]}" > HUBCTL_SHA256SUMS.tmp
fi
mv HUBCTL_SHA256SUMS.tmp HUBCTL_SHA256SUMS
cat HUBCTL_SHA256SUMS
