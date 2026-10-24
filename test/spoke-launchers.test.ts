// The `hub`/`hubctl` launchers the spoke writes into the hub bin dir (P1-T10, Brain decision 31swaq28).
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { cliEntry, installLaunchers, launcherScript, LAUNCHERS } from "../src/spoke/launchers"

const tmp = () => mkdtempSync(path.join(tmpdir(), "hub-launchers-"))

describe("launcherScript", () => {
  test("a bun-capable runtime runs the entry as bun (BUN_BE_BUN=1) with the arguments", () => {
    const script = launcherScript({ execPath: "/Users/x/.opencode/bin/opencode", bun: true, entry: "/pkg/packages/cli/dist/hub-cli.js" })
    expect(script.startsWith("#!/bin/sh\n")).toBe(true)
    expect(script).toContain(`exec env BUN_BE_BUN=1 '/Users/x/.opencode/bin/opencode' '/pkg/packages/cli/dist/hub-cli.js' "$@"\n`)
  })

  test("otherwise node runs the bundle", () => {
    const script = launcherScript({ execPath: "/usr/bin/whatever", bun: false, entry: "/pkg/hub-cli.js" })
    expect(script).toContain(`exec node '/pkg/hub-cli.js' "$@"\n`)
    expect(script).not.toContain("BUN_BE_BUN")
  })

  test("paths are single-quoted for sh (spaces, quotes, $)", () => {
    const script = launcherScript({ execPath: "/A b/it's $HOME/opencode", bun: true, entry: "/c d/x.js" })
    expect(script).toContain(`'/A b/it'\\''s $HOME/opencode' '/c d/x.js'`)
  })

  test("the script really runs: arguments pass through and BUN_BE_BUN reaches the runtime", async () => {
    const dir = tmp()
    const entry = path.join(dir, "entry.js")
    writeFileSync(entry, "console.log(JSON.stringify({ args: process.argv.slice(2), bebun: process.env.BUN_BE_BUN ?? null }))")
    const file = path.join(dir, "hub")
    writeFileSync(file, launcherScript({ execPath: process.execPath, bun: true, entry }), { mode: 0o755 })
    const proc = Bun.spawn([file, "a b", "--json"], { stdout: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(JSON.parse(out)).toEqual({ args: ["a b", "--json"], bebun: "1" })
  })
})

describe("cliEntry", () => {
  test("the built bundle when present", () => {
    const root = tmp()
    const bundle = path.join(root, "packages", "cli", "dist", "hub-cli.js")
    mkdirSync(path.dirname(bundle), { recursive: true })
    writeFileSync(bundle, "")
    expect(cliEntry(root, true)).toBe(bundle)
    expect(cliEntry(root, false)).toBe(bundle)
  })

  test("without a bundle: the TypeScript source for bun, nothing for node", () => {
    const root = tmp()
    expect(cliEntry(root, true)).toBe(path.join(root, "packages", "cli", "src", "main.ts"))
    expect(cliEntry(root, false)).toBeUndefined()
  })
})

describe("installLaunchers", () => {
  const options = (binDir: string) => ({ binDir, execPath: "/bin/opencode", bun: true, entry: "/pkg/hub-cli.js" })

  test("writes hub and hubctl, mode 0755, same script", () => {
    const binDir = tmp()
    const result = installLaunchers(options(binDir))
    expect(LAUNCHERS).toEqual(["hub", "hubctl"])
    expect(result.written.sort()).toEqual(["hub", "hubctl"])
    const script = launcherScript(options(binDir))
    for (const name of LAUNCHERS) {
      const file = path.join(binDir, name)
      expect(readFileSync(file, "utf8")).toBe(script)
      expect(statSync(file).mode & 0o777).toBe(0o755)
    }
  })

  test("creates the bin dir when missing", () => {
    const binDir = path.join(tmp(), "state", "bin")
    installLaunchers(options(binDir))
    expect(existsSync(path.join(binDir, "hub"))).toBe(true)
  })

  test("is idempotent: unchanged launchers are not rewritten", () => {
    const binDir = tmp()
    installLaunchers(options(binDir))
    const before = statSync(path.join(binDir, "hub"))
    const again = installLaunchers(options(binDir))
    expect(again.written).toEqual([])
    expect(statSync(path.join(binDir, "hub")).ino).toBe(before.ino)
    expect(statSync(path.join(binDir, "hub")).mtimeMs).toBe(before.mtimeMs)
  })

  test("rewrites a launcher whose content changed (new OpenCode or package path)", () => {
    const binDir = tmp()
    installLaunchers(options(binDir))
    const result = installLaunchers({ ...options(binDir), execPath: "/new/opencode" })
    expect(result.written.sort()).toEqual(["hub", "hubctl"])
    expect(readFileSync(path.join(binDir, "hub"), "utf8")).toContain("/new/opencode")
  })

  test("restores the mode of an unchanged launcher that lost its execute bit", () => {
    const binDir = tmp()
    installLaunchers(options(binDir))
    chmodSync(path.join(binDir, "hubctl"), 0o644)
    installLaunchers(options(binDir))
    expect(statSync(path.join(binDir, "hubctl")).mode & 0o777).toBe(0o755)
  })
})
