// `hub node run | install | uninstall | status` (design §6.3): run is the daemon (packages/node runNode) until a
// signal; install writes the launchd agent (macOS) or systemd user unit (Linux) from the templates in scripts/
// with this CLI's real runtime and entry, and prints the commands that load it; it never runs launchctl or
// systemctl itself (nor does uninstall or status). --dry-run writes nothing. Each test uses a temporary home.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EXIT, run, type Io } from "../src/cli"

const RUNTIME = "/opt/hub tools/bun"
const ENTRY = "/opt/hub tools/hub-cli.js"

function home(options: { enrolled?: boolean; roots?: string[] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-cli-node-"))
  mkdirSync(path.join(dir, ".config", "hub"), { recursive: true })
  if (options.enrolled !== false) writeFileSync(path.join(dir, ".config", "hub", "config.json"), JSON.stringify({ server: "https://hub.example", token: "mt_secret" }))
  if (options.roots) writeFileSync(path.join(dir, ".config", "hub", "node.json"), JSON.stringify({ workspaceRoots: options.roots }))
  return dir
}

async function cli(argv: string[], options: { home?: string; platform?: NodeJS.Platform; env?: Record<string, string>; signal?: AbortSignal } = {}) {
  let stdout = ""
  let stderr = ""
  const dir = options.home ?? home()
  const io: Io = {
    env: options.env ?? {},
    home: dir,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    platform: options.platform ?? "darwin",
    uid: 501,
    program: { execPath: RUNTIME, entry: ENTRY },
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const code = await run(argv, io)
  return { code, stdout, stderr, home: dir }
}

const PLIST = (dir: string) => path.join(dir, "Library", "LaunchAgents", "io.github.huynle.hub-node.plist")
const UNIT = (dir: string) => path.join(dir, ".config", "systemd", "user", "hub-node.service")

describe("hub node install (macOS: launchd)", () => {
  test("writes the agent with the real runtime, entry and home, and prints the launchctl commands without running them", async () => {
    const r = await cli(["node", "install"], { home: home({ roots: ["/tmp"] }) })
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
    const plist = readFileSync(PLIST(r.home), "utf8")
    expect(plist).toContain("<string>io.github.huynle.hub-node</string>")
    expect(plist).toMatch(/<string>\/opt\/hub tools\/bun<\/string>\s*<string>\/opt\/hub tools\/hub-cli.js<\/string>\s*<string>node<\/string>\s*<string>run<\/string>/)
    expect(plist).toContain(`<string>${r.home}/.local/state/hub/node.log</string>`)
    expect(plist).not.toMatch(/__[A-Z]+__/)
    expect(existsSync(path.join(r.home, ".local", "state", "hub"))).toBe(true)
    expect(r.stdout).toContain(`wrote ${PLIST(r.home)}`)
    expect(r.stdout).toContain(`launchctl bootstrap gui/501 '${PLIST(r.home)}'`)
    expect(r.stdout).toContain("not run")
  })

  test("--dry-run prints the file and the commands and writes nothing", async () => {
    const r = await cli(["node", "install", "--dry-run"], { home: home({ roots: ["/tmp"] }) })
    expect(r.code).toBe(0)
    expect(existsSync(PLIST(r.home))).toBe(false)
    expect(r.stdout).toContain(`would write ${PLIST(r.home)}`)
    expect(r.stdout).toContain("<string>/opt/hub tools/hub-cli.js</string>")
    expect(r.stdout).toContain("launchctl bootstrap gui/501")
  })

  test("again: unchanged; HUB_SPOKE_CONFIG is carried into the service", async () => {
    const dir = home({ roots: ["/tmp"] })
    await cli(["node", "install"], { home: dir })
    expect((await cli(["node", "install"], { home: dir })).stdout).toContain(`${PLIST(dir)} is up to date`)
    const config = path.join(dir, ".config", "hub", "config.json")
    const r = await cli(["node", "install"], { home: dir, env: { HUB_SPOKE_CONFIG: config } })
    expect(r.stdout).toContain(`updated ${PLIST(dir)}`)
    expect(readFileSync(PLIST(dir), "utf8")).toMatch(new RegExp(`<key>HUB_SPOKE_CONFIG</key>\\s*<string>${config.replaceAll(".", "\\.")}</string>`))
  })

  test("warns when the machine is not enrolled or node.json has no workspace roots (the service would exit 78)", async () => {
    const r = await cli(["node", "install"], { home: home({ enrolled: false }) })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("not enrolled")
    expect(r.stderr).toContain("workspaceRoots")
    expect(r.stderr).not.toContain("mt_secret")
  })
})

describe("hub node install (Linux: systemd user unit)", () => {
  test("writes the unit (quoted paths) and prints the systemctl commands", async () => {
    const r = await cli(["node", "install"], { home: home({ roots: ["/tmp"] }), platform: "linux" })
    expect(r.code).toBe(0)
    const unit = readFileSync(UNIT(r.home), "utf8")
    expect(unit).toContain('ExecStart="/opt/hub tools/bun" "/opt/hub tools/hub-cli.js" node run')
    expect(unit).toContain(`Environment=PATH=${r.home}/.bun/bin:`)
    expect(unit).toContain("RestartPreventExitStatus=78")
    expect(unit).not.toMatch(/__[A-Z]+__/)
    expect(r.stdout).toContain("systemctl --user daemon-reload")
    expect(r.stdout).toContain("systemctl --user enable --now hub-node.service")
  })

  test("XDG_CONFIG_HOME is where the unit goes", async () => {
    const dir = home({ roots: ["/tmp"] })
    const xdg = path.join(dir, "xdg")
    const r = await cli(["node", "install", "--dry-run"], { home: dir, platform: "linux", env: { XDG_CONFIG_HOME: xdg } })
    expect(r.stdout).toContain(`would write ${path.join(xdg, "systemd", "user", "hub-node.service")}`)
  })

  test("other platforms: unsupported (exit 7)", async () => {
    const r = await cli(["node", "install"], { platform: "win32" })
    expect(r.code).toBe(EXIT.unavailable)
    expect(r.stderr).toContain("macOS (launchd) and Linux (systemd)")
  })
})

describe("hub node uninstall", () => {
  test("removes the file and prints the commands that stop the service", async () => {
    const dir = home({ roots: ["/tmp"] })
    await cli(["node", "install"], { home: dir })
    const dry = await cli(["node", "uninstall", "--dry-run"], { home: dir })
    expect(existsSync(PLIST(dir))).toBe(true)
    expect(dry.stdout).toContain(`would remove ${PLIST(dir)}`)
    const r = await cli(["node", "uninstall"], { home: dir })
    expect(r.code).toBe(0)
    expect(existsSync(PLIST(dir))).toBe(false)
    expect(r.stdout).toContain("launchctl bootout gui/501/io.github.huynle.hub-node")
    expect((await cli(["node", "uninstall"], { home: dir })).stdout).toContain("not installed")
  })

  test("Linux: stop, drop the enable link, reload", async () => {
    const dir = home({ roots: ["/tmp"] })
    await cli(["node", "install"], { home: dir, platform: "linux" })
    const r = await cli(["node", "uninstall"], { home: dir, platform: "linux" })
    expect(existsSync(UNIT(dir))).toBe(false)
    expect(r.stdout).toContain("systemctl --user stop hub-node.service")
    expect(r.stdout).toContain("default.target.wants/hub-node.service")
    expect(r.stdout).toContain("systemctl --user daemon-reload")
  })
})

describe("hub node status", () => {
  test("the unit, enrolment (never the token), node.json, and how to see the service", async () => {
    const dir = home({ roots: ["/tmp"] })
    const before = await cli(["node", "status"], { home: dir })
    expect(before.code).toBe(0)
    expect(before.stdout).toContain("service: not installed (hub node install)")
    await cli(["node", "install"], { home: dir })
    const r = await cli(["node", "status"], { home: dir })
    expect(r.stdout).toContain(`service: installed, up to date (${PLIST(dir)})`)
    expect(r.stdout).toContain("enrolled with https://hub.example")
    expect(r.stdout).toContain("workspace roots: /tmp")
    expect(r.stdout).toContain("launchctl print gui/501/io.github.huynle.hub-node")
    expect(r.stdout).not.toContain("mt_secret")
    const json = JSON.parse((await cli(["node", "status", "--json"], { home: dir })).stdout)
    expect(json).toMatchObject({ service: { kind: "launchd", installed: true, current: true }, enrolled: { server: "https://hub.example" }, config: { workspaceRoots: ["/tmp"] } })
    expect(JSON.stringify(json)).not.toContain("mt_secret")
  })
})

describe("hub node run", () => {
  let servers: { stop(force?: boolean): void }[] = []
  afterEach(() => {
    for (const s of servers) s.stop(true)
    servers = []
  })

  test("runs the daemon with the machine token until the signal; exit 0", async () => {
    const hellos: unknown[] = []
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        message(ws, msg) {
          const frame = JSON.parse(String(msg))
          if (frame.t === "hello") {
            hellos.push(frame)
            ws.send(JSON.stringify({ t: "welcome", v: 1, machineID: "m1", publicURL: "http://x", features: ["nodes"] }))
          }
        },
      },
    })
    servers.push(server)
    const dir = home({ roots: [tmpdir()] })
    writeFileSync(path.join(dir, ".config", "hub", "config.json"), JSON.stringify({ server: `http://127.0.0.1:${server.port}`, token: "mt_run" }))
    const controller = new AbortController()
    const done = cli(["node", "run"], { home: dir, signal: controller.signal })
    const end = Date.now() + 5000
    while (hellos.length === 0 && Date.now() < end) await Bun.sleep(10)
    expect(hellos[0]).toMatchObject({ t: "hello", role: "node" })
    controller.abort()
    const r = await done
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("[hub node] connected")
    expect(r.stderr).not.toContain("mt_run")
  })

  test("not enrolled: exit 1 with the hint", async () => {
    const r = await cli(["node", "run"], { home: home({ enrolled: false, roots: ["/tmp"] }), signal: AbortSignal.abort() })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("not enrolled")
  })
})

describe("hub node: never loads a service", () => {
  test("the module starts no processes", () => {
    const source = readFileSync(path.join(import.meta.dir, "..", "src", "node.ts"), "utf8")
    expect(source).not.toMatch(/child_process|Bun\.spawn|execFile|spawnSync/)
  })

  test("usage: the subcommands; unknown ones exit 2", async () => {
    expect((await cli(["node"])).code).toBe(EXIT.usage)
    expect((await cli(["node", "load"])).code).toBe(EXIT.usage)
    expect((await cli(["help"])).stdout).toContain("hub node install [--dry-run]")
  })
})
