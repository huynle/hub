// daemonLaunchOptions: whether `hub claude-code daemon` starts Claude Code for hub launches, and with what. It does
// when the Claude Code CLI is found (HUB_CLAUDE_BIN, else `claude` on PATH) and node.json does not withhold
// claude-code; the workspace roots come from node.json at each create, and launched sessions load the same hub
// plugin `hub claude` writes.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { daemonLaunchOptions } from "../src/main.ts"

const program = { execPath: process.execPath, entry: "/opt/hub/hub-cli.js" }

function machine(node?: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "hcm-"))
  const bin = path.join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n")
  chmodSync(path.join(bin, "claude"), 0o755)
  const config = path.join(dir, "config", "config.json")
  mkdirSync(path.dirname(config))
  if (node !== undefined) writeFileSync(path.join(dir, "config", "node.json"), JSON.stringify(node))
  return { dir, bin, env: { PATH: bin, HUB_SPOKE_CONFIG: config, HUB_STATE_DIR: path.join(dir, "state") } as Record<string, string> }
}

describe("daemonLaunchOptions", () => {
  test("with claude on PATH: launches with it, node.json's roots (read at each create) and the hub plugin", () => {
    const m = machine({ workspaceRoots: ["/srv/work"] })
    const options = daemonLaunchOptions({ env: m.env, home: m.dir, program })!
    expect(options.bin).toBe(path.join(m.bin, "claude"))
    expect(options.roots()).toEqual(["/srv/work"])
    writeFileSync(path.join(m.dir, "config", "node.json"), JSON.stringify({ workspaceRoots: ["/srv/other"] }))
    expect(options.roots()).toEqual(["/srv/other"])
    const plugin = options.pluginDir()
    expect(plugin.startsWith(path.join(m.dir, "state", "claude-code", "plugins"))).toBe(true)
    const hooks = readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8")
    expect(hooks).toContain("/opt/hub/hub-cli.js")
    expect(hooks).toContain("claude-code hook")
    expect(options.env).toBe(m.env)
  })

  test("HUB_CLAUDE_BIN names the CLI; none found: no launches", () => {
    const m = machine({ workspaceRoots: ["/srv/work"] })
    expect(daemonLaunchOptions({ env: { ...m.env, HUB_CLAUDE_BIN: path.join(m.bin, "claude") }, home: m.dir, program })?.bin).toBe(path.join(m.bin, "claude"))
    expect(daemonLaunchOptions({ env: { ...m.env, HUB_CLAUDE_BIN: path.join(m.bin, "gone") }, home: m.dir, program })).toBeUndefined()
    expect(daemonLaunchOptions({ env: { ...m.env, PATH: m.dir }, home: m.dir, program })).toBeUndefined()
  })

  test("node.json harnesses claude-code false: no launches", () => {
    const m = machine({ workspaceRoots: ["/srv/work"], harnesses: { "claude-code": false } })
    expect(daemonLaunchOptions({ env: m.env, home: m.dir, program })).toBeUndefined()
  })

  test("the plugin is written only when a launch needs it", () => {
    const m = machine({ workspaceRoots: ["/srv/work"] })
    daemonLaunchOptions({ env: m.env, home: m.dir, program })
    expect(existsSync(path.join(m.dir, "state", "claude-code", "plugins"))).toBe(false)
  })
})
