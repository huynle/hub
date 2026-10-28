// Lossless JSON config merging for merge-config (packages/cli/src/bootstrap/transaction/json-merge.ts): only the
// listed pointers change, every other key (known or not) survives in order, and anything the merge could not
// carry through exactly (duplicate keys, TOML, unparseable text) is refused instead of silently dropped. v1.1: the
// merge edits text in place, so comments and big integers survive (see bootstrap-transaction-jsonc.test.ts).
import { describe, expect, test } from "bun:test"
import { mergeConfigText } from "../src/bootstrap/transaction/json-merge.ts"

const code = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "ok" : r.code)

describe("mergeConfigText", () => {
  test("sets keys and preserves every unknown key, its order, indentation and trailing newline", () => {
    const before = '{\n    "zeta": 1,\n    "$schema": "https://opencode.ai/config.json",\n    "plugin": ["a"],\n    "x": {"keep": [1, 2, {"deep": true}]}\n}\n'
    const r = mergeConfigText(before, "json", [
      { pointer: "/plugin/-", value: "@huynle/hub" },
      { pointer: "/mcp/hub/enabled", value: true },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.endsWith("}\n")).toBe(true)
    expect(r.value).toContain('\n    "zeta": 1,')
    const parsed = JSON.parse(r.value)
    expect(Object.keys(parsed)).toEqual(["zeta", "$schema", "plugin", "x", "mcp"])
    expect(parsed.plugin).toEqual(["a", "@huynle/hub"])
    expect(parsed.x).toEqual({ keep: [1, 2, { deep: true }] })
    expect(parsed.mcp).toEqual({ hub: { enabled: true } })
  })

  test("appending a value already in the array is a no-op (retries are idempotent)", () => {
    const before = '{\n  "plugin": ["@huynle/hub"]\n}\n'
    const r = mergeConfigText(before, "json", [{ pointer: "/plugin/-", value: "@huynle/hub" }])
    expect(r.ok && r.value).toBe(before)
  })

  test("a missing file merges into an empty object", () => {
    const r = mergeConfigText(undefined, "json", [{ pointer: "/a/b", value: 1 }])
    expect(r.ok && JSON.parse(r.value)).toEqual({ a: { b: 1 } })
  })

  test("appending to a missing key creates an array, not an object with a '-' key", () => {
    const r = mergeConfigText('{"theme":"dark"}\n', "json", [{ pointer: "/plugin/-", value: "@huynle/hub" }])
    expect(r.ok && JSON.parse(r.value)).toEqual({ theme: "dark", plugin: ["@huynle/hub"] })
  })

  test("pointer escapes (~0, ~1) and array indexes", () => {
    const r = mergeConfigText('{"l":[0,1]}', "json", [
      { pointer: "/a~1b/c~0d", value: 1 },
      { pointer: "/l/1", value: 9 },
    ])
    expect(r.ok && JSON.parse(r.value)).toEqual({ l: [0, 9], "a/b": { "c~d": 1 } })
  })

  test("refuses what it cannot carry through losslessly (v1.1: as a manual edit)", () => {
    const set = [{ pointer: "/a", value: 1 }] as const
    expect(code(mergeConfigText('{"a":1,"a":2}', "json", set))).toBe("manual_edit_required")
    expect(code(mergeConfigText("a = 1\n", "toml", set))).toBe("manual_edit_required")
    expect(code(mergeConfigText("not json", "json", set))).toBe("manual_edit_required")
    expect(code(mergeConfigText("[1,2]", "json", set))).toBe("conflict")
  })

  test("v1.1: comments and integers beyond 2^53 survive, because only the set value's text changes", () => {
    const set = [{ pointer: "/b", value: 2 }] as const
    expect(mergeConfigText('{"a":1, // comment\n}', "jsonc", set)).toEqual({ ok: true, value: '{"a":1, // comment\n"b":2,\n}' })
    expect(mergeConfigText('{"big":12345678901234567890}', "json", set)).toEqual({ ok: true, value: '{"big":12345678901234567890, "b":2}' })
  })

  test("a plain-JSON jsonc file (no comments) merges", () => {
    const r = mergeConfigText('{"a":1}', "jsonc", [{ pointer: "/b", value: 2 }])
    expect(r.ok && JSON.parse(r.value)).toEqual({ a: 1, b: 2 })
  })

  test("refuses to write through a scalar, out-of-range indexes and prototype keys", () => {
    expect(code(mergeConfigText('{"a":"str"}', "json", [{ pointer: "/a/b", value: 1 }]))).toBe("conflict")
    expect(code(mergeConfigText('{"l":[1]}', "json", [{ pointer: "/l/5", value: 1 }]))).toBe("conflict")
    expect(code(mergeConfigText("{}", "json", [{ pointer: "/__proto__/polluted", value: 1 }]))).toBe("invalid")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
