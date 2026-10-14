// One-time copy of the legacy opencode-voice config/state into the opencode-hub locations. Temp dirs only.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { APP_DIR, configBase, LEGACY_APP_DIR, migrateLegacy, stateBase } from "../src/migrate"

const temp = () => mkdtempSync(path.join(tmpdir(), "hub-migrate-"))
const mode = (p: string) => statSync(p).mode & 0o777

function logger() {
  const lines: string[] = []
  return { lines, log: (m: string) => lines.push(m) }
}

describe("locations", () => {
  test("names and bases", () => {
    expect(APP_DIR).toBe("opencode-hub")
    expect(LEGACY_APP_DIR).toBe("opencode-voice")
    expect(configBase({}, "/home/me")).toBe("/home/me/.config")
    expect(configBase({ XDG_CONFIG_HOME: "/xdg" }, "/home/me")).toBe("/xdg")
    expect(stateBase("/home/me")).toBe("/home/me/.local/state")
  })
})

describe("migrateLegacy", () => {
  test("copies a legacy file, keeping its mode and the original", () => {
    const dir = temp()
    const legacy = path.join(dir, "opencode-voice", "config.json")
    const target = path.join(dir, "opencode-hub", "config.json")
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
    const target = path.join(dir, "state", "opencode-hub")
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
    expect(require("node:fs").readdirSync(path.dirname(target)).sort()).toEqual(["opencode-hub", "opencode-voice"])
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
