// The program entry (main.ts) a standalone hubctl compiles (contracts I3, I6; HBS-13 integration items 2 and 3):
//   - it transitively imports release/trust-root.ts, so `bun build --compile --define HUBCTL_TRUST_ROOT=…` bakes the
//     trust root into the binary (a build without the import would silently ship none);
//   - `machine enroll` (it polls until approved) and `setup apply` / `setup recover` get SIGINT/SIGTERM as an abort
//     signal, so Ctrl-C cancels the device-code poll cleanly, and an apply rolls back instead of dying mid-write.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { fakeHub } from "./bootstrap-enrollment-fake.ts"

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts")

describe("main.ts", () => {
  test("the trust root define reaches the bundle (main.ts imports release/trust-root.ts)", async () => {
    const marker = "hbs13-trust-root-marker-7f3a"
    const dir = mkdtempSync(path.join(tmpdir(), "hub-main-build-"))
    try {
      const outfile = path.join(dir, "hubctl.js")
      // The CLI's own build (Bun.build inside bun test cannot resolve the package.json imports).
      const r = Bun.spawnSync([process.execPath, "build", MAIN, "--target=bun", "--define", `HUBCTL_TRUST_ROOT=${JSON.stringify(marker)}`, "--outfile", outfile])
      expect(r.exitCode).toBe(0)
      expect(readFileSync(outfile, "utf8")).toContain(marker)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("Ctrl-C during machine enroll cancels the device-code poll: exit 4, cancelled, nothing stored", async () => {
    const hub = fakeHub({ polls: [{ status: "pending" }] })
    const home = mkdtempSync(path.join(tmpdir(), "hub-main-sigint-"))
    try {
      const proc = Bun.spawn([process.execPath, MAIN, "machine", "enroll", "--server", hub.url, "--json"], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: home } })
      const end = Date.now() + 10_000
      while (hub.polls === 0 && Date.now() < end) await Bun.sleep(20)
      expect(hub.polls).toBeGreaterThan(0)
      proc.kill("SIGINT")
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      expect(code).toBe(4)
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "cancelled" } })
      expect(existsSync(path.join(home, ".config", "hub", "config.json"))).toBe(false)
    } finally {
      hub.stop()
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)

  test("setup apply and setup recover are given the abort signal too", () => {
    const source = readFileSync(MAIN, "utf8")
    expect(source).toMatch(/argv\[0\] === "setup" && \(argv\[1\] === "apply" \|\| argv\[1\] === "recover"\)/)
  })
})
