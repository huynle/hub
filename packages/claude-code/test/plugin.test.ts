// The plugin directory `hub claude` loads with --plugin-dir (never the user's ~/.claude): hooks.json runs the hook
// bridge (an absolute, quoted command, no shell interpolation of anything else) for every event the spoke uses,
// PermissionRequest with the configured wait and a hook timeout above it, an asyncRewake Stop hook for idle wakes;
// .mcp.json runs the daemon-backed MCP pipe.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HOOK_EVENTS, pluginFiles, writePlugin, type PluginOptions } from "../src/plugin.ts"

const options: PluginOptions = { program: { execPath: "/opt/bun/bin/bun", entry: "/opt/hub/packages/cli/src/main.ts" }, permissionWaitS: 120, rewakeTimeoutS: 3600, version: "0.6.1" }
const BASE = "BUN_BE_BUN=1 '/opt/bun/bin/bun' '/opt/hub/packages/cli/src/main.ts' claude-code hook"

describe("plugin files", () => {
  const files = pluginFiles(options)
  const hooks = JSON.parse(files["hooks/hooks.json"]!).hooks

  test("a plugin manifest, hooks and an MCP server", () => {
    expect(Object.keys(files).sort()).toEqual([".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"])
    expect(JSON.parse(files[".claude-plugin/plugin.json"]!)).toMatchObject({ name: "hub", version: "0.6.1" })
    expect(JSON.parse(files[".mcp.json"]!)).toEqual({ mcpServers: { hub: { command: "/opt/bun/bin/bun", args: ["/opt/hub/packages/cli/src/main.ts", "claude-code", "mcp"], env: { BUN_BE_BUN: "1" } } } })
  })

  test("every event the spoke uses runs the bridge", () => {
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort())
    for (const event of HOOK_EVENTS) for (const group of hooks[event]) for (const hook of group.hooks) expect(hook.command.startsWith(BASE)).toBe(true)
    expect(hooks.PreToolUse[0].matcher).toBe("*")
    expect(hooks.SessionStart[0].matcher).toBeUndefined()
  })

  test("PermissionRequest waits the configured time, under a hook timeout above it; 0 is report only", () => {
    expect(hooks.PermissionRequest[0].hooks).toEqual([{ type: "command", command: `${BASE} --wait 120`, timeout: 122 }])
    const reportOnly = JSON.parse(pluginFiles({ ...options, permissionWaitS: 0 })["hooks/hooks.json"]!).hooks
    expect(reportOnly.PermissionRequest[0].hooks[0].command).toBe(`${BASE} --wait 0`)
  })

  test("Stop runs the bridge and an asyncRewake bridge that can wake the idle session", () => {
    expect(hooks.Stop[0].hooks).toEqual([
      { type: "command", command: BASE, timeout: expect.any(Number) },
      { type: "command", command: `${BASE} --rewake`, asyncRewake: true, timeout: 3600 },
    ])
  })

  test("refuses a program path the shell would interpret", () => {
    for (const entry of ["relative/main.ts", "/opt/it's/main.ts", "/opt/a\nb.ts"]) expect(() => pluginFiles({ ...options, program: { ...options.program, entry } })).toThrow()
  })
})

describe("writePlugin", () => {
  test("writes the files once per configuration into a private directory and returns it", () => {
    const base = mkdtempSync(path.join(tmpdir(), "hcp-"))
    const dir = writePlugin(base, options)
    expect(path.dirname(dir)).toBe(base)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(path.join(dir, "hooks/hooks.json"), "utf8")).hooks.Stop).toBeDefined()
    expect(writePlugin(base, options)).toBe(dir)
    expect(writePlugin(base, { ...options, permissionWaitS: 5 })).not.toBe(dir)
  })
})
