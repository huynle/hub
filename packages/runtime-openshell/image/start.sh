#!/usr/bin/env bash
# hub-sandbox-start: starts hub-sandbox-entry detached and returns at once (the runtime execs it; spike report
# gut64rwq §6: a process started by exec survives the exec when it has its own session and no open stdio). Logs go to
# <sandbox home>/.hub/harness.log. Starting again while the entry runs does nothing.
set -u

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
hub="${HUB_SANDBOX_HOME:-/sandbox}/.hub"
log="$hub/harness.log"
mkdir -p "$hub"

if [ -f "$hub/entry.pid" ] && kill -0 "$(cat "$hub/entry.pid" 2>/dev/null)" 2>/dev/null; then
  echo "hub-sandbox: the harness is already running (pid $(cat "$hub/entry.pid"))"
  exit 0
fi

if command -v setsid >/dev/null 2>&1; then
  setsid nohup "$here/hub-sandbox-entry" >>"$log" 2>&1 </dev/null &
else
  nohup "$here/hub-sandbox-entry" >>"$log" 2>&1 </dev/null &
fi
# The entry rewrites this with its own pid; written here too so a start right after sees it.
echo "$!" >"$hub/entry.pid"
echo "hub-sandbox: started (pid $!, log $log)"
