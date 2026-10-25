#!/usr/bin/env bash
# hub-sandbox-entry: runs the harness of a hub launch inside an OpenShell sandbox (packages/runtime-openshell/image).
# Started detached by hub-sandbox-start (the runtime execs that; the sandbox has no main command, so it stays Ready
# and exec keeps working after the harness ends). In order:
#   1. waits until the runtime's start op has uploaded .hub/config.json (hub URL, launch token, launch ID: the
#      plugin's spoke reads it; this script never does) and touched .hub/ready; a .hub/stop first ends the wait;
#   2. adds .hub/env.json (a JSON object of extra variables; never over the ones below or OpenShell's CA variables);
#   3. sets the offline switches and XDG dirs under the sandbox home, writes the global OpenCode config loading the
#      baked hub plugin, and runs `opencode serve --service` on loopback in /sandbox/work;
#   4. sends the server one request so it loads its instance (and with it the plugin, which connects to the hub);
#   5. on .hub/stop ("graceful": SIGTERM, SIGKILL after HUB_STOP_GRACE seconds; "kill": SIGKILL) or the harness's own
#      end, writes its exit code to .hub/exited and exits with it.
# Same script in the image (/usr/local) and the bootstrap fallback (/sandbox/.hub/opt): the harness and plugin are
# found next to it (<root>/bin/opencode, <root>/lib/hub/node_modules/@huynle/hub). Bash 3.2 compatible (tests run it
# on macOS too). Environment overrides, for tests: HUB_SANDBOX_HOME, HUB_HARNESS_PORT, HUB_STOP_GRACE,
# HUB_POLL_INTERVAL.
set -u

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/.." && pwd)
home="${HUB_SANDBOX_HOME:-/sandbox}"
hub="$home/.hub"
opencode="$root/bin/opencode"
plugin="$root/lib/hub/node_modules/@huynle/hub"
port="${HUB_HARNESS_PORT:-4096}"
grace="${HUB_STOP_GRACE:-10}"
poll="${HUB_POLL_INTERVAL:-0.5}"

say() { echo "[hub-sandbox] $*" >&2; }

mkdir -p "$hub"
echo "$$" >"$hub/entry.pid"
rm -f "$hub/exited"

# 1. Wait for the start op.
say "waiting for $hub/config.json and $hub/ready"
until [ -f "$hub/config.json" ] && [ -e "$hub/ready" ]; do
  if [ -e "$hub/stop" ]; then
    say "stopped before the harness started"
    rm -f "$hub/entry.pid"
    exit 0
  fi
  sleep "$poll"
done

# 2. Extra environment: NUL-separated NAME=value pairs from the harness's own bun (no jq in the fallback image).
protected() {
  case "$1" in
    OPENCODE_DISABLE_* | XDG_* | HOME | PATH | HUB_LAUNCH_CONFIG | HUB_SANDBOX_HOME | BUN_* | LD_*) return 0 ;;
    NODE_EXTRA_CA_CERTS | SSL_CERT_FILE | SSL_CERT_DIR | CURL_CA_BUNDLE | REQUESTS_CA_BUNDLE | GIT_SSL_CAINFO | DENO_CERT) return 0 ;;
  esac
  return 1
}
if [ -f "$hub/env.json" ]; then
  pairs=$(mktemp "${TMPDIR:-/tmp}/hub-env.XXXXXX") || exit 2
  # shellcheck disable=SC2016
  if ! HUB_ENV_JSON="$hub/env.json" BUN_BE_BUN=1 "$opencode" -e '
    // An uncaught error in `bun -e` can end with status 0: fail explicitly.
    let env
    try {
      env = JSON.parse(require("node:fs").readFileSync(process.env.HUB_ENV_JSON, "utf8"))
    } catch {
      process.exit(2)
    }
    if (typeof env !== "object" || env === null || Array.isArray(env)) process.exit(2)
    let out = ""
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || !["string", "number", "boolean"].includes(typeof v)) continue
      const value = String(v)
      if (!value.includes("\0")) out += `${k}=${value}\0`
    }
    process.stdout.write(out)
  ' >"$pairs" 2>/dev/null </dev/null; then
    say "invalid $hub/env.json: expected a JSON object"
    rm -f "$pairs" "$hub/entry.pid"
    echo 2 >"$hub/exited"
    exit 2
  fi
  while IFS= read -r -d '' pair; do
    name="${pair%%=*}"
    if protected "$name"; then
      say "ignoring $name from env.json"
      continue
    fi
    export "${pair?}"
  done <"$pairs"
  rm -f "$pairs"
fi

# 3. The harness's environment and config.
export OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_PROJECT_CONFIG=1
export XDG_CONFIG_HOME="$home/.xdg/config" XDG_DATA_HOME="$home/.xdg/data" XDG_STATE_HOME="$home/.xdg/state" XDG_CACHE_HOME="$home/.xdg/cache"
export HUB_LAUNCH_CONFIG="$hub/config.json"
unset BUN_BE_BUN
if [ -z "${OPENCODE_PASSWORD:-}" ]; then
  OPENCODE_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  export OPENCODE_PASSWORD
fi
mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
json_path=$(printf '%s' "$plugin" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
printf '{ "plugins": [{ "package": "%s", "options": {} }] }\n' "$json_path" >"$XDG_CONFIG_HOME/opencode/opencode.jsonc"

workdir="$home"
[ -d "$home/work" ] && workdir="$home/work"
cd "$workdir" || exit 1
say "starting opencode serve --service on 127.0.0.1:$port in $workdir"
"$opencode" serve --service --hostname 127.0.0.1 --port "$port" &
harness=$!
echo "$harness" >"$hub/harness.pid"

# 4. One authorized request loads the server's instance and the plugin (a --service server may keep its own password
# in $XDG_CONFIG_HOME/opencode/service.json).
# shellcheck disable=SC2016
HUB_KICK_URL="http://127.0.0.1:$port/api/agent" BUN_BE_BUN=1 "$opencode" -e '
  const fs = require("node:fs")
  const password = () => {
    try {
      return JSON.parse(fs.readFileSync(`${process.env.XDG_CONFIG_HOME}/opencode/service.json`, "utf8")).password ?? process.env.OPENCODE_PASSWORD
    } catch {
      return process.env.OPENCODE_PASSWORD
    }
  }
  for (const end = Date.now() + 60_000; Date.now() < end; await Bun.sleep(500)) {
    const ok = await fetch(process.env.HUB_KICK_URL, { headers: { authorization: `Basic ${btoa(`opencode:${password()}`)}` } }).then((r) => r.ok, () => false)
    if (ok) {
      console.error("[hub-sandbox] the harness answered; its plugin is loading")
      process.exit(0)
    }
  }
  console.error("[hub-sandbox] the harness did not answer within 60 s")
' </dev/null &
kick=$!

# 5. Supervise.
stop_harness() {
  if [ "$1" = kill ]; then
    say "stop (kill): SIGKILL"
    kill -KILL "$harness" 2>/dev/null
    return
  fi
  say "stop ($1): SIGTERM, SIGKILL after ${grace}s"
  kill -TERM "$harness" 2>/dev/null
  local started=$SECONDS
  while kill -0 "$harness" 2>/dev/null && [ $((SECONDS - started)) -lt "$grace" ]; do sleep "$poll"; done
  kill -0 "$harness" 2>/dev/null && kill -KILL "$harness" 2>/dev/null
}
trap 'stop_harness graceful' TERM INT

while kill -0 "$harness" 2>/dev/null; do
  if [ -e "$hub/stop" ]; then
    mode=$(head -n 1 "$hub/stop" 2>/dev/null | tr -d '[:space:]')
    stop_harness "${mode:-graceful}"
    break
  fi
  sleep "$poll"
done
wait "$harness"
code=$?
kill "$kick" 2>/dev/null
echo "$code" >"$hub/exited"
rm -f "$hub/harness.pid" "$hub/entry.pid"
say "the harness exited with $code"
exit "$code"
