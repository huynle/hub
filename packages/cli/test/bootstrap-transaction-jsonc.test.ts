// v1.1: lossless JSONC editing for merge-config (packages/cli/src/bootstrap/transaction/json-merge.ts). OpenCode
// configs are often JSONC, with comments and trailing commas, and the user's config must survive structurally: a
// merge splices only the text of the values it sets, and every other byte (comments, trailing commas, key order,
// spacing, numbers written however the user wrote them) stays exactly as it was. Formats hubctl cannot edit that
// way are refused with manual_edit_required (the planner turns them into an unmergeable-format manual edit).
import { describe, expect, test } from "bun:test"
import { mergeConfigText, parseJsonc } from "../src/bootstrap/transaction/json-merge.ts"

const code = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "ok" : r.code)
const merged = (text: string | undefined, sets: { pointer: string; value: unknown }[], format: "json" | "jsonc" = "jsonc"): string => {
  const r = mergeConfigText(text, format, sets as never)
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
  return r.value
}

/** A real-world-shaped OpenCode config: comments everywhere, trailing commas, nested provider settings. */
const OPENCODE_JSONC = `// OpenCode config — synced from my dotfiles, edit with care
{
  "$schema": "https://opencode.ai/config.json",
  /* theme and keybinds */
  "theme": "tokyonight", // dark, always
  "keybinds": {
    "leader": "ctrl+x",
  },
  "plugin": [
    "opencode-notifier", // desktop notifications
    "@my/local-plugin",
  ],
  "provider": {
    "anthropic": {
      "options": { "timeout": 600000, }, // 10 min
    },
  },
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp", "enabled": true },
  },
  "experimental": { "chatMaxRetries": 1e3 },
}
`

describe("parseJsonc", () => {
  test("reads comments and trailing commas as JSON", () => {
    const r = parseJsonc(OPENCODE_JSONC)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({ theme: "tokyonight", plugin: ["opencode-notifier", "@my/local-plugin"], provider: { anthropic: { options: { timeout: 600000 } } } })
  })
  test("refuses duplicate keys and anything that is not JSONC", () => {
    expect(parseJsonc('{"a":1,"a":2}').ok).toBe(false)
    expect(parseJsonc("a = 1").ok).toBe(false)
    expect(parseJsonc('{"a": /* unterminated }').ok).toBe(false)
    expect(parseJsonc('{"a": 1} trailing').ok).toBe(false)
  })
})

describe("mergeConfigText on JSONC", () => {
  test("appends to an array with a trailing comma, keeping every comment and comma", () => {
    const out = merged(OPENCODE_JSONC, [{ pointer: "/plugin/-", value: "@huynle/hub" }])
    expect(out).toBe(OPENCODE_JSONC.replace('    "@my/local-plugin",\n', '    "@my/local-plugin",\n    "@huynle/hub",\n'))
  })

  test("adds a key to an object without moving a trailing line comment", () => {
    const text = '{\n  "theme": "dark" // keep me here\n}\n'
    expect(merged(text, [{ pointer: "/plugin", value: ["@huynle/hub"] }])).toBe('{\n  "theme": "dark", // keep me here\n  "plugin": ["@huynle/hub"]\n}\n')
  })

  test("adds nested keys, creating missing objects, in the config's own indentation", () => {
    const out = merged(OPENCODE_JSONC, [{ pointer: "/mcp/hub", value: { type: "local", enabled: true } }])
    expect(out).toBe(
      OPENCODE_JSONC.replace(
        '"enabled": true },\n  },',
        '"enabled": true },\n    "hub": {\n      "type": "local",\n      "enabled": true\n    },\n  },',
      ),
    )
    const deep = merged(OPENCODE_JSONC, [{ pointer: "/hub/mode", value: "session" }])
    expect(deep).toBe(OPENCODE_JSONC.replace('"experimental": { "chatMaxRetries": 1e3 },\n}', '"experimental": { "chatMaxRetries": 1e3 },\n  "hub": {\n    "mode": "session"\n  },\n}'))
  })

  test("replaces an existing value in place; everything around it is untouched", () => {
    const out = merged(OPENCODE_JSONC, [{ pointer: "/theme", value: "dark" }])
    expect(out).toBe(OPENCODE_JSONC.replace('"theme": "tokyonight", // dark, always', '"theme": "dark", // dark, always'))
    const nested = merged(OPENCODE_JSONC, [{ pointer: "/provider/anthropic/options/timeout", value: 300000 }])
    expect(nested).toBe(OPENCODE_JSONC.replace('"timeout": 600000, }', '"timeout": 300000, }'))
  })

  test("an inline object gets an inline member", () => {
    expect(merged('{"a": {"b": 1}}', [{ pointer: "/a/c", value: 2 }])).toBe('{"a": {"b": 1, "c": 2}}')
    expect(merged('{ "a": [1, 2] }', [{ pointer: "/a/-", value: 3 }])).toBe('{ "a": [1, 2, 3] }')
  })

  test("an empty object or array gets its first member", () => {
    expect(merged("{}\n", [{ pointer: "/a", value: 1 }])).toBe('{\n  "a": 1\n}\n')
    expect(merged('{\n  "plugin": []\n}\n', [{ pointer: "/plugin/-", value: "x" }])).toBe('{\n  "plugin": ["x"]\n}\n')
    expect(merged("// header\n{ /* nothing yet */ }\n", [{ pointer: "/a", value: true }])).toBe('// header\n{ /* nothing yet */\n  "a": true\n}\n')
  })

  test("a set that changes nothing returns the bytes as they were", () => {
    expect(merged(OPENCODE_JSONC, [{ pointer: "/plugin/-", value: "opencode-notifier" }])).toBe(OPENCODE_JSONC)
    expect(merged(OPENCODE_JSONC, [{ pointer: "/theme", value: "tokyonight" }])).toBe(OPENCODE_JSONC)
  })

  test("several sets apply in order, each to the text the previous one left", () => {
    const out = merged(OPENCODE_JSONC, [
      { pointer: "/plugin/-", value: "@huynle/hub" },
      { pointer: "/mcp/hub/enabled", value: true },
      { pointer: "/plugin/0", value: "opencode-notifier@2" },
    ])
    const r = parseJsonc(out)
    expect(r.ok && r.value).toMatchObject({ plugin: ["opencode-notifier@2", "@my/local-plugin", "@huynle/hub"], mcp: { hub: { enabled: true } } })
    for (const comment of ["// OpenCode config", "/* theme and keybinds */", "// dark, always", "// desktop notifications", "// 10 min"]) expect(out).toContain(comment)
    expect(out).toContain('"experimental": { "chatMaxRetries": 1e3 },')
  })

  test("a .json file with comments is merged the same way", () => {
    const text = '{\n  // generated\n  "a": 1,\n}\n'
    expect(merged(text, [{ pointer: "/b", value: 2 }], "json")).toBe('{\n  // generated\n  "a": 1,\n  "b": 2,\n}\n')
  })

  test("numbers and strings the user wrote are never re-encoded", () => {
    const text = '{"big": 12345678901234567890, "e": 1E3, "s": "caf\\u00e9"}'
    expect(merged(text, [{ pointer: "/x", value: 1 }])).toBe('{"big": 12345678901234567890, "e": 1E3, "s": "caf\\u00e9", "x": 1}')
  })

  test("what cannot be edited losslessly is a manual edit, not a bare conflict", () => {
    const set = [{ pointer: "/a", value: 1 }] as const
    expect(code(mergeConfigText("a = 1\n", "toml", set))).toBe("manual_edit_required")
    expect(code(mergeConfigText("not json", "jsonc", set))).toBe("manual_edit_required")
    expect(code(mergeConfigText('{"a":1,"a":2}', "jsonc", set))).toBe("manual_edit_required")
    expect(code(mergeConfigText('{"a": 1 /* open', "jsonc", set))).toBe("manual_edit_required")
  })

  test("structural mismatches stay conflicts; prototype keys stay invalid", () => {
    expect(code(mergeConfigText("[1,2]", "jsonc", [{ pointer: "/a", value: 1 }]))).toBe("conflict")
    expect(code(mergeConfigText('{"a":"str"}', "jsonc", [{ pointer: "/a/b", value: 1 }]))).toBe("conflict")
    expect(code(mergeConfigText('{"l":[1]}', "jsonc", [{ pointer: "/l/5", value: 1 }]))).toBe("conflict")
    expect(code(mergeConfigText("{}", "jsonc", [{ pointer: "/__proto__/x", value: 1 }]))).toBe("invalid")
  })
})
