// The legacy @huynle/opencode-voice package: a thin re-export of @huynle/hub, kept in step with it. There is no
// @huynle/opencode-hub shim: that name was never published.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { RENAME_NOTICE, renameNotice } from "../packages/opencode-voice-shim/notice.ts"

const root = path.join(import.meta.dir, "..")
const shimDir = path.join(root, "packages", "opencode-voice-shim")
const main = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const shim = JSON.parse(readFileSync(path.join(shimDir, "package.json"), "utf8"))

describe("main package", () => {
  test("is @huynle/hub with the hub-server bin and the legacy aliases", () => {
    expect(main.name).toBe("@huynle/hub")
    expect(main.bin).toEqual({ "hub-server": "bin/hub.ts", "opencode-hub": "bin/hub.ts", "opencode-voice-hub": "bin/hub.ts" })
    expect(main.repository.url).toContain("github.com/huynle/hub.git")
    expect(main.homepage).toContain("github.com/huynle/hub")
    expect(main.bugs.url).toContain("github.com/huynle/hub/issues")
    for (const k of ["hub", "agent", "harness", "opencode-plugin"]) expect(main.keywords).toContain(k)
  })

  test("does not ship the shim", () => {
    expect(main.files.some((f: string) => f.startsWith("packages"))).toBe(false)
    for (const f of main.files) expect(existsSync(path.join(root, f))).toBe(true)
  })
})

describe("legacy shim package", () => {
  test("is @huynle/opencode-voice at the hub's version, depending on it", () => {
    expect(shim.name).toBe("@huynle/opencode-voice")
    expect(shim.version).toBe(main.version)
    expect(shim.dependencies).toEqual({ "@huynle/hub": `^${main.version}` })
    expect(shim.bin).toBeUndefined() // the hub package already provides opencode-voice-hub
  })

  test("re-exports every entry point of the hub", () => {
    expect(Object.keys(shim.exports)).toEqual(Object.keys(main.exports))
    for (const [entry, file] of Object.entries(shim.exports as Record<string, string>)) {
      if (entry === "./package.json") continue
      const source = readFileSync(path.join(shimDir, file), "utf8")
      const target = entry === "." ? "./server" : entry
      expect(source).toContain(`from "@huynle/hub/${target.slice(2)}"`)
      expect(shim.files).toContain(file.slice(2))
    }
    expect(shim.files).toContain("notice.ts")
  })

  test("prints the rename notice once per process", () => {
    const lines: string[] = []
    renameNotice((m) => lines.push(m))
    renameNotice((m) => lines.push(m))
    expect(lines).toEqual([RENAME_NOTICE])
    expect(RENAME_NOTICE).toContain("@huynle/hub")
    expect(RENAME_NOTICE).not.toContain("opencode-hub")
  })
})
