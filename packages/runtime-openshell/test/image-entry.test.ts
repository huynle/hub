// The sandbox image's start and entry scripts (image/start.sh, image/entry.sh), run for real with bash against a fake
// `opencode` in a temporary root laid out like the image (<root>/bin, <root>/lib/hub/...) and a temporary sandbox home
// (HUB_SANDBOX_HOME instead of /sandbox). The fake serves HTTP like `opencode serve` and records what it was given;
// its `BUN_BE_BUN=1 opencode -e` mode runs the real bun, as the OpenCode binary does.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const IMAGE = path.join(import.meta.dir, "..", "image")
const BUN = process.execPath
setDefaultTimeout(30_000)

const FAKE_SERVE = `
const out = process.env.FAKE_OUT!
const fs = require("node:fs")
const path = require("node:path")
const log = (line: string) => fs.appendFileSync(path.join(out, "events"), line + "\\n")
const port = Number(process.argv[process.argv.indexOf("--port") + 1])
fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME!, "opencode"), { recursive: true })
// Like a --service server: it keeps its own password in service.json (FAKE_PASSWORD_LATE_MS: written only after it
// listens, as a slow start may), else it uses OPENCODE_PASSWORD.
const servicePassword = process.env.FAKE_SERVICE_PASSWORD
const writePassword = () => fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME!, "opencode", "service.json"), JSON.stringify({ password: servicePassword }))
if (servicePassword && !process.env.FAKE_PASSWORD_LATE_MS) writePassword()
if (servicePassword && process.env.FAKE_PASSWORD_LATE_MS) setTimeout(writePassword, Number(process.env.FAKE_PASSWORD_LATE_MS))
fs.writeFileSync(path.join(out, "serve.json"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }))
// Basic auth like OpenCode: a --service server answers only its own password (never OPENCODE_PASSWORD, even before
// service.json is written), a plain server OPENCODE_PASSWORD; anything else is 401 and the entry's kick retries.
const expected = () => servicePassword ?? process.env.OPENCODE_PASSWORD
Bun.serve({ hostname: "127.0.0.1", port, fetch(req) {
  const auth = req.headers.get("authorization") ?? ""
  log("request " + new URL(req.url).pathname + " " + auth)
  return auth === "Basic " + btoa("opencode:" + expected()) ? new Response("{}") : new Response("unauthorized", { status: 401 })
} })
log("listening")
process.on("SIGTERM", () => {
  log("SIGTERM")
  if (process.env.FAKE_IGNORE_TERM !== "1") process.exit(0)
})
if (process.env.FAKE_EXIT) setTimeout(() => process.exit(Number(process.env.FAKE_EXIT)), 300)
setInterval(() => {}, 1000)
`

const FAKE_OPENCODE = `#!/usr/bin/env bash
if [ "\${BUN_BE_BUN:-}" = 1 ]; then exec "${BUN}" "$@"; fi
if [ "$1" = serve ]; then shift; exec "${BUN}" "$(dirname "$0")/../fake-serve.ts" "$@"; fi
echo "fake opencode: $*" >&2
exit 64
`

interface Box {
  readonly base: string
  readonly root: string
  readonly home: string
  readonly hub: string
  readonly out: string
  readonly port: number
  readonly env: Record<string, string>
}

const boxes: Box[] = []
const procs: Bun.Subprocess[] = []

afterEach(async () => {
  for (const p of procs.splice(0)) p.kill("SIGKILL")
  for (const b of boxes.splice(0)) {
    // Detached entries (start.sh) are killed through their pid files.
    for (const f of ["entry.pid", "harness.pid"]) {
      try {
        process.kill(Number(readFileSync(path.join(b.hub, f), "utf8").trim()), "SIGKILL")
      } catch {}
    }
    rmSync(b.base, { recursive: true, force: true })
  }
})

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = s.port!
  s.stop(true)
  return port
}

async function box(extraEnv: Record<string, string> = {}): Promise<Box> {
  const base = realpathSync(mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hub-image-entry-")))
  const root = path.join(base, "root")
  const home = path.join(base, "sandbox")
  const out = path.join(base, "out")
  for (const d of [path.join(root, "bin"), path.join(root, "lib/hub/node_modules/@huynle/hub"), path.join(home, "work"), out]) mkdirSync(d, { recursive: true })
  writeFileSync(path.join(root, "fake-serve.ts"), FAKE_SERVE)
  writeFileSync(path.join(root, "bin/opencode"), FAKE_OPENCODE)
  copyFileSync(path.join(IMAGE, "entry.sh"), path.join(root, "bin/hub-sandbox-entry"))
  copyFileSync(path.join(IMAGE, "start.sh"), path.join(root, "bin/hub-sandbox-start"))
  for (const f of ["opencode", "hub-sandbox-entry", "hub-sandbox-start"]) chmodSync(path.join(root, "bin", f), 0o755)
  const port = await freePort()
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    HUB_SANDBOX_HOME: home,
    HUB_HARNESS_PORT: String(port),
    HUB_POLL_INTERVAL: "0.1",
    FAKE_OUT: out,
    NODE_EXTRA_CA_CERTS: "/run/openshell-supervisor-ca/material/ca.crt",
    SSL_CERT_FILE: "/run/openshell-supervisor-ca/material/ca-bundle.crt",
    ...extraEnv,
  }
  const b = { base, root, home, hub: path.join(home, ".hub"), out, port, env }
  boxes.push(b)
  return b
}

function entry(b: Box): Bun.Subprocess {
  const p = Bun.spawn(["bash", path.join(b.root, "bin/hub-sandbox-entry")], { env: b.env, cwd: b.base, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}

function ready(b: Box, env: Record<string, unknown> | string | undefined = undefined): void {
  mkdirSync(b.hub, { recursive: true })
  writeFileSync(path.join(b.hub, "config.json"), JSON.stringify({ hubURL: "http://host.openshell.internal:4097", token: "hlt1.secret", launchID: "l1" }))
  if (env !== undefined) writeFileSync(path.join(b.hub, "env.json"), typeof env === "string" ? env : JSON.stringify(env))
  writeFileSync(path.join(b.hub, "ready"), "")
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")
const events = (b: Box) => read(path.join(b.out, "events"))
const served = (b: Box) => JSON.parse(read(path.join(b.out, "serve.json"))) as { argv: string[]; cwd: string; env: Record<string, string> }

async function until(cond: () => boolean, ms = 10_000, what = "condition"): Promise<void> {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(50)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
}

async function exited(p: Bun.Subprocess, ms = 10_000): Promise<number | "timeout"> {
  return Promise.race([p.exited, Bun.sleep(ms).then(() => "timeout" as const)])
}

describe("hub-sandbox-entry", () => {
  test("waits for .hub/config.json and .hub/ready before it runs the harness", async () => {
    const b = await box()
    entry(b)
    await Bun.sleep(600)
    expect(existsSync(path.join(b.out, "serve.json"))).toBe(false)
    mkdirSync(b.hub, { recursive: true })
    writeFileSync(path.join(b.hub, "ready"), "")
    await Bun.sleep(600)
    expect(existsSync(path.join(b.out, "serve.json"))).toBe(false)
    ready(b)
    await until(() => events(b).includes("listening"), 10_000, "the harness")
  })

  test("runs `opencode serve --service` on loopback in /sandbox/work", async () => {
    const b = await box()
    ready(b)
    entry(b)
    await until(() => events(b).includes("listening"), 10_000, "the harness")
    const s = served(b)
    expect(s.argv).toEqual(["--service", "--hostname", "127.0.0.1", "--port", String(b.port)])
    expect(s.cwd).toBe(path.join(b.home, "work"))
    expect(read(path.join(b.hub, "harness.pid")).trim()).toMatch(/^\d+$/)
  })

  test("offline switches, XDG dirs under the sandbox home, the launch config, and the proxy CA env kept", async () => {
    const b = await box()
    ready(b)
    entry(b)
    await until(() => events(b).includes("listening"), 10_000, "the harness")
    const { env } = served(b)
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
    expect(env.XDG_CONFIG_HOME).toBe(path.join(b.home, ".xdg/config"))
    expect(env.XDG_DATA_HOME).toBe(path.join(b.home, ".xdg/data"))
    expect(env.XDG_STATE_HOME).toBe(path.join(b.home, ".xdg/state"))
    expect(env.XDG_CACHE_HOME).toBe(path.join(b.home, ".xdg/cache"))
    expect(env.HUB_LAUNCH_CONFIG).toBe(path.join(b.hub, "config.json"))
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/run/openshell-supervisor-ca/material/ca.crt")
    expect(env.SSL_CERT_FILE).toBe("/run/openshell-supervisor-ca/material/ca-bundle.crt")
    expect(env.OPENCODE_PASSWORD).toMatch(/^[0-9a-f]{32,}$/)
    expect(env.BUN_BE_BUN).toBeUndefined()
  })

  test("adds .hub/env.json, but never over the offline switches, XDG dirs or CA env", async () => {
    const b = await box()
    ready(b, { FOO: "a b\nc $HOME `id`", N: 3, "bad-name": "x", OPENCODE_DISABLE_PROJECT_CONFIG: "0", NODE_EXTRA_CA_CERTS: "/evil", XDG_CONFIG_HOME: "/evil", OBJ: { a: 1 } })
    entry(b)
    await until(() => events(b).includes("listening"), 10_000, "the harness")
    const { env } = served(b)
    expect(env.FOO).toBe("a b\nc $HOME `id`")
    expect(env.N).toBe("3")
    expect(env["bad-name"]).toBeUndefined()
    expect(env.OBJ).toBeUndefined()
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/run/openshell-supervisor-ca/material/ca.crt")
    expect(env.XDG_CONFIG_HOME).toBe(path.join(b.home, ".xdg/config"))
  })

  test("refuses an env.json that is not a JSON object", async () => {
    const b = await box()
    ready(b, "[1,2")
    const p = entry(b)
    expect(await exited(p)).toBe(2)
    expect(existsSync(path.join(b.out, "serve.json"))).toBe(false)
  })

  test("loads the baked hub plugin through the global OpenCode config", async () => {
    const b = await box()
    ready(b)
    entry(b)
    await until(() => events(b).includes("listening"), 10_000, "the harness")
    const config = JSON.parse(read(path.join(b.home, ".xdg/config/opencode/opencode.jsonc")))
    expect(config.plugins).toEqual([{ package: path.join(b.root, "lib/hub/node_modules/@huynle/hub"), options: {} }])
  })

  test("a service that writes its password only after it listens is still reached with that password (it retries on 401)", async () => {
    const b = await box({ FAKE_SERVICE_PASSWORD: "svc-pw", FAKE_PASSWORD_LATE_MS: "600" })
    ready(b)
    entry(b)
    await until(() => events(b).includes(`request /api/agent Basic ${btoa("opencode:svc-pw")}`), 15_000, "the plugin kick with the service's password")
  })

  test("starts the plugin with a request, using the service's own password", async () => {
    const b = await box({ FAKE_SERVICE_PASSWORD: "svc-pw" })
    ready(b)
    entry(b)
    // The first kick may race the service writing its password (401, then a retry with it): wait for that request.
    await until(() => events(b).includes(`request /api/agent Basic ${btoa("opencode:svc-pw")}`), 15_000, "the plugin kick with the service's password")
  })

  test("graceful stop: SIGTERM to the harness, then the entry exits and records the exit code", async () => {
    const b = await box()
    ready(b)
    const p = entry(b)
    await until(() => events(b).includes("listening"), 10_000, "the harness")
    writeFileSync(path.join(b.hub, "stop"), "graceful\n")
    expect(await exited(p)).toBe(0)
    expect(events(b)).toContain("SIGTERM")
    expect(read(path.join(b.hub, "exited")).trim()).toBe("0")
    expect(existsSync(path.join(b.hub, "harness.pid"))).toBe(false)
  })

  test("a harness that ignores SIGTERM is killed after the grace period", async () => {
    const b = await box({ FAKE_IGNORE_TERM: "1", HUB_STOP_GRACE: "1" })
    ready(b)
    const p = entry(b)
    await until(() => events(b).includes("listening"), 10_000, "the harness")
    writeFileSync(path.join(b.hub, "stop"), "graceful\n")
    expect(await exited(p, 8000)).toBe(137)
    expect(read(path.join(b.hub, "exited")).trim()).toBe("137")
  })

  test("kill stop: SIGKILL at once", async () => {
    const b = await box({ FAKE_IGNORE_TERM: "1", HUB_STOP_GRACE: "30" })
    ready(b)
    const p = entry(b)
    await until(() => events(b).includes("listening"), 10_000, "the harness")
    writeFileSync(path.join(b.hub, "stop"), "kill\n")
    expect(await exited(p, 5000)).toBe(137)
    expect(events(b)).not.toContain("SIGTERM")
  })

  test("a stop before ready ends the wait without running the harness", async () => {
    const b = await box()
    const p = entry(b)
    await Bun.sleep(300)
    mkdirSync(b.hub, { recursive: true })
    writeFileSync(path.join(b.hub, "stop"), "graceful\n")
    expect(await exited(p)).toBe(0)
    expect(existsSync(path.join(b.out, "serve.json"))).toBe(false)
  })

  test("the harness's own exit ends the entry with its code", async () => {
    const b = await box({ FAKE_EXIT: "3" })
    ready(b)
    const p = entry(b)
    expect(await exited(p)).toBe(3)
    expect(read(path.join(b.hub, "exited")).trim()).toBe("3")
  })

  test("never prints the launch token", async () => {
    const b = await box({ FAKE_EXIT: "0" })
    ready(b)
    const p = entry(b)
    await exited(p)
    const output = (await new Response(p.stdout as ReadableStream).text()) + (await new Response(p.stderr as ReadableStream).text())
    expect(output).not.toContain("hlt1.secret")
  })
})

describe("hub-sandbox-start", () => {
  test("starts the entry detached, logging to .hub/harness.log, and returns at once", async () => {
    const b = await box()
    const started = Date.now()
    const p = Bun.spawn(["bash", path.join(b.root, "bin/hub-sandbox-start")], { env: b.env, stdout: "pipe", stderr: "pipe" })
    expect(await exited(p, 5000)).toBe(0)
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = Number(read(path.join(b.hub, "entry.pid")).trim())
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).not.toThrow()
    ready(b)
    await until(() => events(b).includes("listening"), 10_000, "the harness")
    await until(() => read(path.join(b.hub, "harness.log")).includes("hub-sandbox"), 5000, "the log")
  })

  test("a second start while the entry runs starts nothing", async () => {
    const b = await box()
    const first = Bun.spawn(["bash", path.join(b.root, "bin/hub-sandbox-start")], { env: b.env, stdout: "pipe", stderr: "pipe" })
    expect(await exited(first, 5000)).toBe(0)
    const pid = read(path.join(b.hub, "entry.pid")).trim()
    const second = Bun.spawn(["bash", path.join(b.root, "bin/hub-sandbox-start")], { env: b.env, stdout: "pipe", stderr: "pipe" })
    expect(await exited(second, 5000)).toBe(0)
    expect(await new Response(second.stdout as ReadableStream).text()).toContain("already running")
    expect(read(path.join(b.hub, "entry.pid")).trim()).toBe(pid)
  })
})
