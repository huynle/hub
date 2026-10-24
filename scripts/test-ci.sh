#!/usr/bin/env bash
# CI test runner: each test file in its own `bun test` process, each with a time limit.
#
# Bun 1.3.5 occasionally hangs a full single-process `bun test` run on Linux (idle, ~1 in 8 runs) after
# many files have created servers and sockets; no single file hangs on its own. Running files in
# separate processes avoids the hang, and the per-file limit turns any future hang into a clear failure.
set -uo pipefail
cd "$(dirname "$0")/.."
LIMIT="${TEST_FILE_TIMEOUT:-120}"
# The hub serves the built console (web/dist); test/central-web.test.ts checks it.
if ! build=$(npx --no-install vite build --config web/vite.config.ts --logLevel error 2>&1); then
  echo "::group::FAILED web build"
  echo "$build" | tail -40
  echo "::endgroup::"
  exit 1
fi
failed=()
total=0
# Root tests, then the workspace packages' own tests (packages/<name>/test; the shim has none).
for file in test/*.test.ts packages/*/test/*.test.ts; do
  [ -e "$file" ] || continue
  total=$((total + 1))
  if ! output=$(timeout "$LIMIT" bun test "$file" 2>&1); then
    status=$?
    failed+=("$file")
    echo "::group::FAILED $file (exit $status$([ "$status" = 124 ] && echo ", timed out after ${LIMIT}s"))"
    echo "$output" | tail -60
    echo "::endgroup::"
  fi
done
echo "$((total - ${#failed[@]}))/$total test files passed"
if [ "${#failed[@]}" -gt 0 ]; then
  printf 'failed: %s\n' "${failed[@]}"
  exit 1
fi
