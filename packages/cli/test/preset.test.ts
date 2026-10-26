// `hub preset …` routes to the preset spoke's command line (packages/preset), in the source CLI and in the bundle
// (whose official presets are inlined JSON).
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { run, USAGE, type Io } from "../src/cli"

const root = path.join(import.meta.dir, "..", "..", "..")

function io() {
  const out: string[] = []
  const err: string[] = []
  const home = mkdtempSync(path.join(tmpdir(), "hub-cli-preset-"))
  const value: Io = { env: { HOME: home, HUB_SPOKE_CONFIG: path.join(home, "config.json") }, home, cwd: home, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }
  return { io: value, out, err }
}

describe("hub preset", () => {
  test("is in the usage", () => {
    expect(USAGE).toContain("hub preset run <name|file>")
    expect(USAGE).toContain("hub preset list")
  })

  test("list and check go to the preset command line", async () => {
    const a = io()
    expect(await run(["preset", "list"], a.io)).toBe(0)
    expect(a.out.join("")).toMatch(/^aider\s/m)
    const b = io()
    expect(await run(["preset", "check", "goose"], b.io)).toBe(0)
    expect(b.out.join("")).toContain("goose: a valid preset")
  })

  test("run without enrolment exits 1 before anything starts", async () => {
    const c = io()
    expect(await run(["preset", "run", "aider"], c.io)).toBe(1)
    expect(c.err.join("")).toMatch(/not enrolled/)
  })

  test("the bundle carries the official presets", async () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "hub-cli-preset-bundle-")), "hub-cli.js")
    const build = Bun.spawnSync([process.execPath, "build", path.join(root, "packages/cli/src/main.ts"), "--target=node", `--outfile=${out}`])
    expect(build.exitCode).toBe(0)
    const listed = Bun.spawnSync([process.execPath, out, "preset", "list"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), BUN_BE_BUN: "1" } })
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout.toString()).toMatch(/^goose\s/m)
  }, 30_000)
})
