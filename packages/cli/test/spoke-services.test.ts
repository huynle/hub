// `hub claude-code install | uninstall | status` and `hub codex-spoke install | uninstall | status`: like `hub node
// install`, they write a launchd agent (macOS) or systemd user unit (Linux) from the templates in scripts/ that keeps
// the per-user spoke running (`hub claude-code daemon`, `hub codex-spoke serve`), so hub launches can be placed on the
// machine without a `hub claude` / `hub codex` run first. They print the load commands and never run them (nor
// launchctl / systemctl at all). --dry-run writes nothing. Each test uses a temporary home.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EXIT, run, type Io } from "../src/cli"

const RUNTIME = "/opt/hub tools/bun"
const ENTRY = "/opt/hub tools/hub-cli.js"
const root = path.join(import.meta.dir, "..", "..", "..")

function home(options: { enrolled?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-cli-svc-"))
  mkdirSync(path.join(dir, ".config", "hub"), { recursive: true })
  if (options.enrolled !== false) writeFileSync(path.join(dir, ".config", "hub", "config.json"), JSON.stringify({ server: "https://hub.example", token: "mt_secret" }))
  return dir
}

async function cli(argv: string[], options: { home?: string; platform?: NodeJS.Platform; env?: Record<string, string> } = {}) {
  let stdout = ""
  let stderr = ""
  const dir = options.home ?? home()
  const io: Io = {
    env: options.env ?? { PATH: "/nonexistent" },
    home: dir,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    platform: options.platform ?? "darwin",
    uid: 501,
    program: { execPath: RUNTIME, entry: ENTRY },
  }
  const code = await run(argv, io)
  return { code, stdout, stderr, home: dir }
}

const SERVICES = [
  { command: "claude-code", label: "io.github.huynle.hub-claude-code", unit: "hub-claude-code.service", args: ["claude-code", "daemon"], log: "claude-code.log", carried: "HUB_CLAUDE_BIN" },
  { command: "codex-spoke", label: "io.github.huynle.hub-codex-spoke", unit: "hub-codex-spoke.service", args: ["codex-spoke", "serve"], log: "codex-spoke.log", carried: "CODEX_HOME" },
] as const

for (const s of SERVICES) {
  const PLIST = (dir: string) => path.join(dir, "Library", "LaunchAgents", `${s.label}.plist`)
  const UNIT = (dir: string) => path.join(dir, ".config", "systemd", "user", s.unit)

  describe(`hub ${s.command} install`, () => {
    test("macOS: writes the agent running the spoke with the real runtime and entry; prints launchctl commands, never runs them", async () => {
      const r = await cli([s.command, "install"])
      expect(r.stderr).toBe("")
      expect(r.code).toBe(0)
      const plist = readFileSync(PLIST(r.home), "utf8")
      expect(plist).toContain(`<string>${s.label}</string>`)
      expect(plist).toMatch(new RegExp(`<string>/opt/hub tools/bun</string>\\s*<string>/opt/hub tools/hub-cli.js</string>\\s*<string>${s.args[0]}</string>\\s*<string>${s.args[1]}</string>`))
      expect(plist).toContain(`<string>${r.home}/.local/state/hub/${s.log}</string>`)
      expect(plist).toContain(`${r.home}/.local/bin`)
      expect(plist).not.toMatch(/__[A-Z]+__/)
      expect(plist).toContain(`hub ${s.command} uninstall removes it`)
      expect(r.stdout).toContain(`wrote ${PLIST(r.home)}`)
      expect(r.stdout).toContain(`launchctl bootstrap gui/501 '${PLIST(r.home)}'`)
      expect(r.stdout).toContain("not run")
    })

    test("--dry-run prints the file and writes nothing; settings that move its files are carried into the service", async () => {
      const r = await cli([s.command, "install", "--dry-run"], { env: { PATH: "/nonexistent", HUB_STATE_DIR: "/srv/hub state", [s.carried]: "/opt/x" } })
      expect(r.code).toBe(0)
      expect(existsSync(PLIST(r.home))).toBe(false)
      expect(r.stdout).toContain(`would write ${PLIST(r.home)}`)
      expect(r.stdout).toMatch(/<key>HUB_STATE_DIR<\/key>\s*<string>\/srv\/hub state<\/string>/)
      expect(r.stdout).toMatch(new RegExp(`<key>${s.carried}</key>\\s*<string>/opt/x</string>`))
    })

    test("Linux: writes the systemd user unit and prints the systemctl commands", async () => {
      const r = await cli([s.command, "install"], { platform: "linux" })
      expect(r.code).toBe(0)
      const unit = readFileSync(UNIT(r.home), "utf8")
      expect(unit).toContain(`ExecStart="/opt/hub tools/bun" "/opt/hub tools/hub-cli.js" ${s.args.join(" ")}`)
      expect(unit).toContain("Restart=on-failure")
      expect(unit).not.toMatch(/__[A-Z]+__/)
      expect(r.stdout).toContain(`systemctl --user enable --now ${s.unit}`)
    })

    test("warns when the machine is not enrolled (never prints the token)", async () => {
      const r = await cli([s.command, "install", "--dry-run"], { home: home({ enrolled: false }) })
      expect(r.code).toBe(0)
      expect(r.stderr).toContain("not enrolled")
      expect(r.stderr).not.toContain("mt_secret")
    })

    test("other platforms: unsupported (exit 7)", async () => {
      const r = await cli([s.command, "install"], { platform: "win32" })
      expect(r.code).toBe(EXIT.unavailable)
    })
  })

  describe(`hub ${s.command} uninstall and status`, () => {
    test("status shows the service file and enrolment; uninstall removes it and prints the stop commands", async () => {
      const dir = home()
      expect((await cli([s.command, "status"], { home: dir })).stdout).toContain(`service: not installed (hub ${s.command} install)`)
      await cli([s.command, "install"], { home: dir })
      const status = await cli([s.command, "status"], { home: dir })
      expect(status.code).toBe(0)
      expect(status.stdout).toContain(`service: installed, up to date (${PLIST(dir)})`)
      expect(status.stdout).toContain("enrolled with https://hub.example")
      expect(status.stdout).not.toContain("mt_secret")
      const json = JSON.parse((await cli([s.command, "status", "--json"], { home: dir })).stdout)
      expect(json).toMatchObject({ service: { kind: "launchd", installed: true, current: true }, enrolled: { server: "https://hub.example" } })
      const dry = await cli([s.command, "uninstall", "--dry-run"], { home: dir })
      expect(dry.stdout).toContain(`would remove ${PLIST(dir)}`)
      expect(existsSync(PLIST(dir))).toBe(true)
      const r = await cli([s.command, "uninstall"], { home: dir })
      expect(r.code).toBe(0)
      expect(existsSync(PLIST(dir))).toBe(false)
      expect(r.stdout).toContain(`launchctl bootout gui/501/${s.label}`)
    })
  })

  test(`the ${s.command} templates ship in the npm package`, () => {
    const files = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).files as string[]
    expect(files).toContain(`scripts/${s.label}.plist`)
    expect(files).toContain(`scripts/${s.unit}`)
  })
}

describe("the spokes' own subcommands still reach them", () => {
  test("hub claude-code with no or an unknown subcommand prints its usage (now listing install)", async () => {
    const r = await cli(["claude-code", "bogus"])
    expect(r.code).toBe(EXIT.usage)
    expect(r.stderr).toContain("install")
  })

  test("hub codex-spoke with an unknown subcommand prints its usage (now listing install)", async () => {
    const r = await cli(["codex-spoke", "bogus"])
    expect(r.code).toBe(EXIT.usage)
    expect(r.stderr).toContain("install")
  })

  test("the module starts no processes", () => {
    const source = readFileSync(path.join(import.meta.dir, "..", "src", "spoke-services.ts"), "utf8")
    expect(source).not.toMatch(/child_process|Bun\.spawn|execFile|spawnSync/)
  })
})
