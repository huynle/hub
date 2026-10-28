// HBS-06: reading an OpenCode 2 config (JSONC) to decide how the Hub plugin and the hubctl MCP server are registered.
// The inspection is pure: it never edits, it classifies. Registered entries need no edit, older pins and the legacy
// plugin name are drift (one precise edit), and anything ambiguous or foreign is refused (conflict), never
// overwritten: a duplicate plugin, a newer pin than this hubctl, another server already named "hub".
import { describe, expect, test } from "bun:test"
import { HUB_MCP_NAME, HUB_PLUGIN_PACKAGE, inspectOpencodeConfig, mcpServerSets, pluginSets } from "../src/bootstrap/adapters/opencode/config.ts"
import { mergeConfigText } from "../src/bootstrap/transaction/json-merge.ts"
import { AUTHORITY, CONFIG_WITH_EVERYTHING, insertionsOf } from "./bootstrap/opencode-adapter-fixtures.ts"

const inspect = (text: string | undefined, pluginVersion?: string) => inspectOpencodeConfig(text, { authority: AUTHORITY, ...(pluginVersion ? { pluginVersion } : {}) })
const value = <T>(r: { ok: true; value: T } | { ok: false; code: string; message: string }): T => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
  return r.value
}
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code)

describe("inspectOpencodeConfig", () => {
  test("names: the npm package and the MCP server name", () => {
    expect(HUB_PLUGIN_PACKAGE).toBe("@huynle/hub")
    expect(HUB_MCP_NAME).toBe("hub")
  })

  test("a missing config needs both registrations", () => {
    const r = value(inspect(undefined))
    expect(r.plugin.state).toBe("absent")
    expect(r.mcp.state).toBe("absent")
  })

  test("a config with comments, other plugins, MCP servers and providers but no hub needs both", () => {
    const r = value(inspect(CONFIG_WITH_EVERYTHING))
    expect(r.plugin.state).toBe("absent")
    expect(r.mcp.state).toBe("absent")
  })

  test("an unpinned plugin entry is registered (the user chose to track the latest release)", () => {
    const r = value(inspect('{ "plugins": ["other", "@huynle/hub"] }', "0.7.1"))
    expect(r.plugin).toMatchObject({ state: "registered", pointer: "/plugins/1" })
    expect(r.findings.map((f) => f.code)).toContain("plugin-unpinned")
  })

  test("an entry pinned to exactly the wanted version, as a string or a package object, is registered", () => {
    expect(value(inspect('{ "plugins": ["@huynle/hub@0.7.1"] }', "0.7.1")).plugin.state).toBe("registered")
    expect(value(inspect('{ "plugins": [{ "package": "@huynle/hub@0.7.1", "options": { "x": 1 } }] }', "0.7.1")).plugin.state).toBe("registered")
    expect(value(inspect('{ "plugins": ["npm:@huynle/hub@0.7.1"] }', "0.7.1")).plugin.state).toBe("registered")
  })

  test("a checkout or GitHub install of the plugin is the user's own choice and is left alone", () => {
    for (const spec of ['"github:huynle/hub"', '{ "package": "/Users/dev/projects/hub" }', '"file:///Users/dev/src/hub"']) {
      const r = value(inspect(`{ "plugins": [${spec}] }`, "0.7.1"))
      expect(r.plugin.state).toBe("registered")
      expect(r.findings.map((f) => f.code)).toContain("plugin-custom-source")
    }
  })

  test("version drift: an older pin is updated in place (the package field of an object entry only)", () => {
    const s = value(inspect('{ "plugins": ["a", "@huynle/hub@0.6.0"] }', "0.7.1"))
    expect(s.plugin).toMatchObject({ state: "drift", pointer: "/plugins/1", found: "0.6.0" })
    expect(pluginSets(s.plugin, { authority: AUTHORITY, pluginVersion: "0.7.1" })).toEqual([{ pointer: "/plugins/1", value: "@huynle/hub@0.7.1" }])
    const o = value(inspect('{ "plugins": [{ "package": "@huynle/hub@0.6.0", "options": { "keep": true } }] }', "0.7.1"))
    expect(pluginSets(o.plugin, { authority: AUTHORITY, pluginVersion: "0.7.1" })).toEqual([{ pointer: "/plugins/0/package", value: "@huynle/hub@0.7.1" }])
  })

  test("the legacy plugin name (@huynle/opencode-voice only re-exports hub) is drift too", () => {
    const r = value(inspect('{ "plugins": ["@huynle/opencode-voice"] }'))
    expect(r.plugin).toMatchObject({ state: "drift", pointer: "/plugins/0" })
    expect(r.findings.map((f) => f.code)).toContain("plugin-legacy-name")
    expect(pluginSets(r.plugin, { authority: AUTHORITY })).toEqual([{ pointer: "/plugins/0", value: "@huynle/hub" }])
  })

  test("an absent plugin is appended to plugins", () => {
    const r = value(inspect('{ "plugins": ["a"] }', "0.7.1"))
    expect(pluginSets(r.plugin, { authority: AUTHORITY, pluginVersion: "0.7.1" })).toEqual([{ pointer: "/plugins/-", value: "@huynle/hub@0.7.1" }])
    expect(pluginSets(value(inspect('{ "plugins": ["@huynle/hub"] }')).plugin, { authority: AUTHORITY })).toEqual([])
  })

  test("a duplicate plugin is refused: OpenCode would load one of them, and hubctl cannot tell which you meant", () => {
    expect(code(inspect('{ "plugins": ["@huynle/hub", "@huynle/hub@0.7.1"] }'))).toBe("conflict")
    expect(code(inspect('{ "plugins": ["@huynle/hub", "github:huynle/hub"] }'))).toBe("conflict")
    expect(code(inspect('{ "plugins": ["@huynle/hub"], "plugin": ["@huynle/opencode-voice"] }'))).toBe("conflict")
  })

  test("a pin newer than this hubctl is refused, never downgraded", () => {
    expect(code(inspect('{ "plugins": ["@huynle/hub@0.9.0"] }', "0.7.1"))).toBe("conflict")
  })

  test("shapes hubctl cannot merge into are conflicts; unparseable text needs a manual edit", () => {
    expect(code(inspect('{ "plugins": "@huynle/hub" }'))).toBe("conflict")
    expect(code(inspect('{ "mcp": [] }'))).toBe("conflict")
    expect(code(inspect('{ "mcp": { "servers": 3 } }'))).toBe("conflict")
    expect(code(inspect("[]"))).toBe("conflict")
    expect(code(inspect('{ "plugins": [ '))).toBe("manual_edit_required")
    expect(code(inspect('{ "a": 1, "a": 2 }'))).toBe("manual_edit_required")
  })

  test("MCP: hubctl at the stable authority is registered; a hub/hubctl elsewhere (a plugin-cache launcher) is stale", () => {
    const ok = value(inspect(JSON.stringify({ mcp: { servers: { hub: { type: "local", command: [AUTHORITY, "mcp"] } } } })))
    expect(ok.mcp.state).toBe("registered")
    const stale = value(inspect(JSON.stringify({ mcp: { servers: { hub: { type: "local", command: ["/Users/dev/.local/state/hub/bin/hubctl", "mcp"], environment: { A: "1" } } } } })))
    expect(stale.mcp.state).toBe("stale")
    expect(stale.findings.map((f) => f.code)).toContain("mcp-stale-authority")
  })

  test("MCP: another server named hub, or hub's mcp under another name, is refused", () => {
    expect(code(inspect(JSON.stringify({ mcp: { servers: { hub: { type: "remote", url: "https://hub.example/mcp" } } } })))).toBe("conflict")
    expect(code(inspect(JSON.stringify({ mcp: { servers: { hub: { type: "local", command: ["npx", "other-mcp"] } } } })))).toBe("conflict")
    expect(code(inspect(JSON.stringify({ mcp: { servers: { hubctl: { type: "local", command: [AUTHORITY, "mcp"] } } } })))).toBe("conflict")
  })
})

describe("mcpServerSets", () => {
  test("absent: the whole entry; stale: only the command (the user's environment and disabled flag stay)", () => {
    expect(value(mcpServerSets(undefined, AUTHORITY))).toEqual([{ pointer: "/mcp/servers/hub", value: { type: "local", command: [AUTHORITY, "mcp"] } }])
    const stale = JSON.stringify({ mcp: { servers: { hub: { type: "local", command: ["/x/hubctl", "mcp"], disabled: true } } } })
    expect(value(mcpServerSets(stale, AUTHORITY))).toEqual([{ pointer: "/mcp/servers/hub/command", value: [AUTHORITY, "mcp"] }])
    const done = JSON.stringify({ mcp: { servers: { hub: { type: "local", command: [AUTHORITY, "mcp"] } } } })
    expect(value(mcpServerSets(done, AUTHORITY))).toEqual([])
  })

  test("merged into the full config, only the edited regions change: every other byte stays", () => {
    const sets = [...pluginSets(value(inspect(CONFIG_WITH_EVERYTHING, "0.7.1")).plugin, { authority: AUTHORITY, pluginVersion: "0.7.1" }), ...value(mcpServerSets(CONFIG_WITH_EVERYTHING, AUTHORITY))]
    const out = value(mergeConfigText(CONFIG_WITH_EVERYTHING, "jsonc", sets))
    // Insertions only: the original text is a subsequence of the result, and what was added is the two registrations.
    const extra = insertionsOf(CONFIG_WITH_EVERYTHING, out)
    expect(extra).toBeDefined()
    expect(extra!.replace(/\s+/g, "")).toBe(`"@huynle/hub@0.7.1","hub":{"type":"local","command":["${AUTHORITY}","mcp"]},`)
    expect(out).toContain("// a provider the user configured; never touched")
    expect(out).toContain('"x-unknown-field": { "kept": [1, 2, 3,], },')
    expect(value(inspect(out, "0.7.1"))).toMatchObject({ plugin: { state: "registered" }, mcp: { state: "registered" } })
  })

  test("refuses to compute an edit for a conflicting config", () => {
    expect(code(mcpServerSets(JSON.stringify({ mcp: { servers: { hub: { type: "remote", url: "https://x" } } } }), AUTHORITY))).toBe("conflict")
  })
})
