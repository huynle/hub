// A real standalone hubctl build for this host's target (scripts/hubctl-release.ts build): the binary runs with no
// bun or node on PATH and no repository beside it, prints the CLI's version, and behaves the same when invoked as
// `hub` (the alias is one command surface, contracts §1). Cross-compiling the other targets happens in the release
// workflow. The first run of a freshly built binary can take seconds (the OS scans it), hence the timeouts.
import { describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { supportedTarget, targetOf } from "../src/bootstrap/contracts/index.ts"

const repo = path.join(import.meta.dir, "..", "..", "..")
const version = JSON.parse(readFileSync(path.join(repo, "packages/cli/package.json"), "utf8")).version as string
const host = targetOf(process.platform, process.arch, process.platform === "linux" ? "glibc" : "none")
const supported = supportedTarget(host) !== undefined

/** Runs with PATH set to an empty directory: no bun, node or anything else to fall back on. */
const emptyPath = mkdtempSync(path.join(tmpdir(), "hubctl-empty-path-"))
function exec(argv: string[], cwd: string) {
  const r = Bun.spawnSync(argv, { cwd, env: { PATH: emptyPath, HOME: cwd }, stdout: "pipe", stderr: "pipe" })
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

describe.skipIf(!supported)(`standalone hubctl (${host})`, () => {
  const outdir = mkdtempSync(path.join(tmpdir(), "hubctl-build-"))
  const bin = path.join(mkdtempSync(path.join(tmpdir(), "hubctl-bin-")), "hubctl")
  const cwd = path.dirname(bin)

  test("builds with the release tool", () => {
    const r = Bun.spawnSync([process.execPath, "scripts/hubctl-release.ts", "build", host, "--outdir", outdir], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    expect(r.stderr.toString()).toContain(`hubctl-${host}`)
    expect(r.exitCode).toBe(0)
    expect(existsSync(path.join(outdir, `hubctl-${host}`))).toBe(true)
    copyFileSync(path.join(outdir, `hubctl-${host}`), bin)
    Bun.spawnSync(["chmod", "755", bin])
    symlinkSync(bin, path.join(cwd, "hub"))
  }, 180_000)

  test("neither bun nor node is reachable from the test PATH", () => {
    expect(exec(["/bin/sh", "-c", "command -v bun || command -v node || echo none"], cwd).stdout.trim()).toBe("none")
  })

  test("--version prints the CLI version without bun, node or the repository", () => {
    const r = exec([bin, "--version"], cwd)
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe(version)
  }, 60_000)

  test("--help prints the command surface", () => {
    const r = exec([bin, "--help"], cwd)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("Exit codes")
  }, 60_000)

  test("`hub` (a link to the same binary) is the same command surface", () => {
    const hub = path.join(cwd, "hub")
    for (const args of [["--version"], ["--help"]]) expect(exec([hub, ...args], cwd)).toEqual(exec([bin, ...args], cwd))
  }, 60_000)
})
