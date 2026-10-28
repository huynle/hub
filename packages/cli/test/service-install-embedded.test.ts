// `hub node install`, `hub claude-code install` and `hub codex-spoke install` render their units from the templates
// embedded in the program (renderServiceUnit with the argv contract), never from scripts/ on disk, so a standalone
// hubctl can install them (HBS-13 integration item 3). They still print the activation commands and never run them,
// point an unenrolled machine at `hubctl machine enroll`, and carry the hub-installed Codex into the codex-spoke unit.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderServiceUnit } from "../src/bootstrap/adapters/node-services/render.ts"
import { run, type Io } from "../src/cli"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function home(enrolled = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-cli-embedded-"))
  dirs.push(dir)
  mkdirSync(path.join(dir, ".config", "hub"), { recursive: true })
  if (enrolled) writeFileSync(path.join(dir, ".config", "hub", "config.json"), JSON.stringify({ server: "https://hub.example", token: "mt_secret" }))
  writeFileSync(path.join(dir, ".config", "hub", "node.json"), JSON.stringify({ workspaceRoots: ["/tmp"] }))
  return dir
}

async function cli(argv: string[], dir: string, options: { platform?: NodeJS.Platform; program?: { execPath: string; entry: string } } = {}) {
  let stdout = ""
  let stderr = ""
  const io: Io = {
    env: { PATH: "/nonexistent" },
    home: dir,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    platform: options.platform ?? "darwin",
    uid: 501,
    program: options.program ?? { execPath: "/opt/hub/bun", entry: "/opt/hub/hub-cli.js" },
  }
  return { code: await run(argv, io), stdout, stderr }
}

describe("service installs from the embedded templates", () => {
  test("node.ts and spoke-services.ts read no template from disk", () => {
    for (const file of ["node.ts", "spoke-services.ts"]) {
      const source = readFileSync(path.join(import.meta.dir, "..", "src", file), "utf8")
      expect(source).not.toContain("templateDir")
      expect(source).not.toMatch(/readFileSync\([^)]*scripts/)
    }
  })

  test("the unit is exactly renderServiceUnit's, with the install command in its header", async () => {
    for (const [platform, manager, file] of [
      ["darwin", "launchd", "Library/LaunchAgents/io.github.huynle.hub-node.plist"],
      ["linux", "systemd-user", ".config/systemd/user/hub-node.service"],
    ] as const) {
      const dir = home()
      const r = await cli(["node", "install"], dir, { platform })
      expect(r.code).toBe(0)
      const expected = renderServiceUnit({ service: "node", manager, layout: { kind: "script", runtime: "/opt/hub/bun", entry: "/opt/hub/hub-cli.js" }, home: dir, writtenBy: "hub node" })
      if (!expected.ok) throw new Error(JSON.stringify(expected.issues))
      expect(readFileSync(path.join(dir, file), "utf8")).toBe(expected.value.text)
      expect(expected.value.text).toContain("hub node uninstall removes it")
      expect(r.stdout).toContain("not run")
    }
  })

  test("a standalone hubctl (/$bunfs entry) starts itself, with no runtime word", async () => {
    const dir = home()
    const r = await cli(["node", "install"], dir, { program: { execPath: "/Users/dev/.local/bin/hubctl", entry: "/$bunfs/root/hubctl" } })
    expect(r.code).toBe(0)
    const plist = readFileSync(path.join(dir, "Library/LaunchAgents/io.github.huynle.hub-node.plist"), "utf8")
    expect(plist).toMatch(/<string>\/Users\/dev\/\.local\/bin\/hubctl<\/string>\s*<string>node<\/string>\s*<string>run<\/string>/)
    expect(plist).not.toContain("$bunfs")
  })

  test("an unenrolled machine is pointed at hubctl machine enroll", async () => {
    for (const argv of [["node", "install"], ["claude-code", "install"], ["node", "status"]]) {
      const r = await cli(argv, home(false))
      expect(r.stderr + r.stdout).toContain("hubctl machine enroll")
      expect(r.stderr + r.stdout).not.toContain("/hub dialog")
    }
  })

  test("the codex-spoke unit carries the hub-installed Codex (HUB_CODEX_BIN)", async () => {
    const dir = home()
    const codex = path.join(dir, ".local/share/hub/harnesses/codex/current/bin/codex")
    mkdirSync(path.dirname(codex), { recursive: true })
    writeFileSync(codex, "#!/bin/sh\n")
    chmodSync(codex, 0o755)
    const r = await cli(["codex-spoke", "install"], dir)
    expect(r.code).toBe(0)
    const plist = readFileSync(path.join(dir, "Library/LaunchAgents/io.github.huynle.hub-codex-spoke.plist"), "utf8")
    expect(plist).toMatch(new RegExp(`<key>HUB_CODEX_BIN</key>\\s*<string>${codex.replaceAll(".", "\\.")}</string>`))
  })
})
