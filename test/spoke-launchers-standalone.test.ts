// The `hub`/`hubctl` launchers prefer the standalone hubctl (HBS-13 integration item 5): when `hubctl setup` (or the
// user) installed it as user-bin:hubctl (~/.local/bin/hubctl), the launchers exec it, so services, MCP clients and
// shells all run the one stable, signed authority instead of the bundle in the plugin's cache. Checked at run time,
// so a hubctl installed after OpenCode started is used at once; without one the bundle runs as before.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { launcherScript, standaloneHubctl } from "../src/spoke/launchers"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "hub-launchers-standalone-"))
  dirs.push(d)
  return d
}

async function runScript(script: string, dir: string): Promise<string> {
  const file = path.join(dir, "hub")
  writeFileSync(file, script, { mode: 0o755 })
  const proc = Bun.spawn([file, "x y"], { stdout: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

describe("standalone hubctl preferred", () => {
  test("standaloneHubctl is ~/.local/bin/hubctl", () => {
    expect(standaloneHubctl("/Users/dev")).toBe("/Users/dev/.local/bin/hubctl")
  })

  test("the launcher execs the standalone hubctl when it is there, the bundle otherwise", async () => {
    const dir = tmp()
    const entry = path.join(dir, "entry.js")
    writeFileSync(entry, "console.log('bundle ' + process.argv.slice(2).join(','))")
    const standalone = path.join(dir, "bin", "hubctl")
    const script = launcherScript({ execPath: process.execPath, bun: true, entry, standalone })
    expect(await runScript(script, dir)).toBe("bundle x y")
    mkdirSync(path.dirname(standalone), { recursive: true })
    writeFileSync(standalone, "#!/bin/sh\necho \"standalone $*\"\n")
    chmodSync(standalone, 0o755)
    expect(await runScript(script, dir)).toBe("standalone x y")
  }, 30_000)

  test("the standalone path is quoted for sh", () => {
    const script = launcherScript({ execPath: "/o", bun: true, entry: "/e.js", standalone: "/A b/it's/hubctl" })
    expect(script).toContain(`'/A b/it'\\''s/hubctl'`)
  })
})
