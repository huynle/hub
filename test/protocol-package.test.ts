// The protocol lives in the private workspace package packages/protocol (@huynle/hub-protocol). The hub imports it
// by relative path through src/protocol.ts, and the published @huynle/hub ships its sources.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import * as reexport from "../src/protocol"

const root = path.join(import.meta.dir, "..")
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"))
const main = json("package.json")
const pkgFile = path.join(root, "packages", "protocol", "package.json")

describe("protocol workspace package", () => {
  test("is private, ESM, and exports its TypeScript source", () => {
    expect(existsSync(pkgFile)).toBe(true)
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"))
    expect(pkg.name).toBe("@huynle/hub-protocol")
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe("module")
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
  })

  test("is a workspace of the hub, next to the SDK, the CLI, the runtime SDK, the node, the OpenShell runtime, the spoke SDK, the testkit, the Claude Code spoke, the conformance suite and the preset spoke (the shim stays outside)", () => {
    expect(main.workspaces).toEqual(["packages/protocol", "packages/sdk", "packages/cli", "packages/runtime-sdk", "packages/node", "packages/runtime-openshell", "packages/spoke-sdk", "packages/testkit", "packages/claude-code", "packages/conformance", "packages/preset"])
  })

  test("is shipped in the hub's npm package", () => {
    expect(main.files).toContain("packages/protocol/src")
    expect(main.files).toContain("packages/protocol/package.json")
  })

  test("src/protocol.ts re-exports it by relative path", async () => {
    const source = readFileSync(path.join(root, "src", "protocol.ts"), "utf8")
    expect(source).toContain('from "../packages/protocol/src/index.ts"')
    expect(source).not.toContain("@huynle/hub-protocol")
    const protocol = await import(path.join(root, "packages", "protocol", "src", "index.ts"))
    expect(Object.keys(reexport).sort()).toEqual(Object.keys(protocol).sort())
    expect(reexport.PROTOCOL_VERSION).toBe(protocol.PROTOCOL_VERSION)
    expect(reexport.parseSpokeMessage).toBe(protocol.parseSpokeMessage)
  })
})
