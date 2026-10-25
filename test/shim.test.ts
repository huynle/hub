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
    // Only the private workspace packages ship inside the hub: the protocol (src/protocol.ts re-exports it), the SDK
    // sources (the hub's API client, importable by relative path) and the CLI bundle (built by prepack,
    // `npm run build:cli`; the spoke's hub/hubctl launchers run it), and the sources of `hub node`, its runtime SDK and
    // its OpenShell runtime (with its sandbox image sources: the runtime uses the layout and the bootstrap build), and the
    // spoke SDK's sources (the OpenCode spoke's src/spoke files re-export it by relative path).
    const packaged = main.files.filter((f: string) => f.startsWith("packages"))
    expect(packaged).toEqual([
      "packages/protocol/src",
      "packages/protocol/package.json",
      "packages/sdk/src",
      "packages/sdk/package.json",
      "packages/cli/dist/hub-cli.js",
      "packages/runtime-sdk/src",
      "packages/runtime-sdk/package.json",
      "packages/node/src",
      "packages/node/package.json",
      "packages/runtime-openshell/src",
      "packages/runtime-openshell/package.json",
      "packages/runtime-openshell/image",
      "packages/spoke-sdk/src",
      "packages/spoke-sdk/package.json",
    ])
    expect(main.files.some((f: string) => f.includes("opencode-voice-shim"))).toBe(false)
    expect(main.workspaces).not.toContain("packages/opencode-voice-shim")
    const built = new Set(["packages/cli/dist/hub-cli.js"])
    for (const f of main.files) if (!built.has(f)) expect(existsSync(path.join(root, f))).toBe(true)
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
