// One-time copy of the legacy opencode-hub / opencode-voice config and state into the Hub locations. Temp dirs only.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { APP_DIR, configBase, LEGACY_APP_DIRS, migrateFirst, migrateLegacy, stateBase } from "../src/migrate"

const temp = () => mkdtempSync(path.join(tmpdir(), "hub-migrate-"))
const mode = (p: string) => statSync(p).mode & 0o777

function logger() {
  const lines: string[] = []
  return { lines, log: (m: string) => lines.push(m) }
}

describe("locations", () => {
  test("names and bases", () => {
    expect(APP_DIR).toBe("hub")
    // most recent first: opencode-hub (0.5), then opencode-voice (<= 0.4)
    expect(LEGACY_APP_DIRS).toEqual(["opencode-hub", "opencode-voice"])
    expect(configBase({}, "/home/me")).toBe("/home/me/.config")
    expect(configBase({ XDG_CONFIG_HOME: "/xdg" }, "/home/me")).toBe("/xdg")
    expect(stateBase("/home/me")).toBe("/home/me/.local/state")
  })
})

describe("migrateLegacy", () => {
  test("copies a legacy file, keeping its mode and the original", () => {
    const dir = temp()
    const legacy = path.join(dir, "opencode-voice", "config.json")
    const target = path.join(dir, "hub", "config.json")
    mkdirSync(path.dirname(legacy), { recursive: true })
    writeFileSync(legacy, '{"token":"t"}')
    chmodSync(legacy, 0o600)
    const { lines, log } = logger()
    expect(migrateLegacy(legacy, target, { log })).toBe("migrated")
    expect(readFileSync(target, "utf8")).toBe('{"token":"t"}')
    expect(mode(target)).toBe(0o600)
    expect(mode(path.dirname(target))).toBe(0o700)
    expect(readFileSync(legacy, "utf8")).toBe('{"token":"t"}')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(legacy)
    expect(lines[0]).toContain(target)
  })

  test("copies a legacy directory recursively with modes, skipping listed top-level names", () => {
    const dir = temp()
    const legacy = path.join(dir, "state", "opencode-voice")
    const target = path.join(dir, "state", "hub")
    mkdirSync(path.join(legacy, "sub"), { recursive: true })
    chmodSync(legacy, 0o700)
    writeFileSync(path.join(legacy, "keys.json"), "k")
    chmodSync(path.join(legacy, "keys.json"), 0o600)
    writeFileSync(path.join(legacy, "sub", "a.json"), "a")
    chmodSync(path.join(legacy, "sub", "a.json"), 0o640)
    writeFileSync(path.join(legacy, "hub.pid"), "{}")
    const { log } = logger()
    expect(migrateLegacy(legacy, target, { log, skip: ["hub.pid"] })).toBe("migrated")
    expect(readFileSync(path.join(target, "keys.json"), "utf8")).toBe("k")
    expect(mode(path.join(target, "keys.json"))).toBe(0o600)
    expect(mode(path.join(target, "sub", "a.json"))).toBe(0o640)
    expect(mode(target)).toBe(0o700)
    expect(existsSync(path.join(target, "hub.pid"))).toBe(false)
    expect(existsSync(path.join(legacy, "hub.pid"))).toBe(true)
    expect(existsSync(path.join(legacy, "keys.json"))).toBe(true)
    // no temporary leftovers next to the target
    expect(require("node:fs").readdirSync(path.dirname(target)).sort()).toEqual(["hub", "opencode-voice"])
  })

  test("does nothing when the target exists", () => {
    const dir = temp()
    const legacy = path.join(dir, "old.json")
    const target = path.join(dir, "new.json")
    writeFileSync(legacy, "old")
    writeFileSync(target, "new")
    const { lines, log } = logger()
    expect(migrateLegacy(legacy, target, { log })).toBe("none")
    expect(readFileSync(target, "utf8")).toBe("new")
    expect(lines).toEqual([])
  })

  test("does nothing when there is no legacy copy", () => {
    const dir = temp()
    const { lines, log } = logger()
    expect(migrateLegacy(path.join(dir, "missing"), path.join(dir, "new"), { log })).toBe("none")
    expect(existsSync(path.join(dir, "new"))).toBe(false)
    expect(lines).toEqual([])
  })

  test("a failed copy is reported, never thrown, and leaves no target", () => {
    const dir = temp()
    const legacy = path.join(dir, "old")
    mkdirSync(legacy)
    writeFileSync(path.join(legacy, "secret"), "x")
    chmodSync(path.join(legacy, "secret"), 0o000)
    const target = path.join(dir, "new")
    const { lines, log } = logger()
    const result = migrateLegacy(legacy, target, { log })
    chmodSync(path.join(legacy, "secret"), 0o600)
    if (process.getuid?.() === 0) return // root reads anything
    expect(result).toBe("failed")
    expect(existsSync(target)).toBe(false)
    expect(lines[0]).toMatch(/could not/i)
  })
})

describe("migrateFirst", () => {
  function homeWith(...names: string[]) {
    const dir = temp()
    for (const name of names) {
      mkdirSync(path.join(dir, name), { recursive: true, mode: 0o700 })
      writeFileSync(path.join(dir, name, "config.json"), name)
      chmodSync(path.join(dir, name, "config.json"), 0o600)
    }
    const at = (name: string) => path.join(dir, name, "config.json")
    return { dir, at, legacies: LEGACY_APP_DIRS.map(at) }
  }

  test("prefers the opencode-hub copy over the opencode-voice one, keeping both", () => {
    const { at, legacies } = homeWith("opencode-hub", "opencode-voice")
    const { lines, log } = logger()
    expect(migrateFirst(legacies, at("hub"), { log })).toBe("migrated")
    expect(readFileSync(at("hub"), "utf8")).toBe("opencode-hub")
    expect(mode(at("hub"))).toBe(0o600)
    expect(readFileSync(at("opencode-hub"), "utf8")).toBe("opencode-hub")
    expect(readFileSync(at("opencode-voice"), "utf8")).toBe("opencode-voice")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(at("opencode-hub"))
  })

  test("falls back to the opencode-voice copy", () => {
    const { at, legacies } = homeWith("opencode-voice")
    const { lines, log } = logger()
    expect(migrateFirst(legacies, at("hub"), { log })).toBe("migrated")
    expect(readFileSync(at("hub"), "utf8")).toBe("opencode-voice")
    expect(lines[0]).toContain(at("opencode-voice"))
  })

  test("does nothing when the target exists or there is no legacy copy", () => {
    const existing = homeWith("hub", "opencode-hub")
    const { lines, log } = logger()
    expect(migrateFirst(existing.legacies, existing.at("hub"), { log })).toBe("none")
    expect(readFileSync(existing.at("hub"), "utf8")).toBe("hub")
    const empty = homeWith()
    expect(migrateFirst(empty.legacies, empty.at("hub"), { log })).toBe("none")
    expect(existsSync(empty.at("hub"))).toBe(false)
    expect(lines).toEqual([])
  })

  test("passes skip through to directory copies", () => {
    const dir = temp()
    const legacy = path.join(dir, "opencode-hub")
    mkdirSync(legacy, { mode: 0o700 })
    writeFileSync(path.join(legacy, "keys.json"), "k")
    writeFileSync(path.join(legacy, "hub.pid"), "{}")
    const target = path.join(dir, "hub")
    expect(migrateFirst([legacy, path.join(dir, "opencode-voice")], target, { log: () => {}, skip: ["hub.pid"] })).toBe("migrated")
    expect(existsSync(path.join(target, "keys.json"))).toBe(true)
    expect(existsSync(path.join(target, "hub.pid"))).toBe(false)
  })
})
