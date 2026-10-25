// The OpenShell runtime is a private workspace package (@huynle/hub-runtime-openshell), shipped as sources inside
// @huynle/hub like the node and the runtime SDK, and type-checked with the rest of the repository.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..", "..", "..")
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"))

describe("runtime-openshell workspace package", () => {
  test("is private, ESM, and exports its TypeScript source", () => {
    const pkg = json("packages/runtime-openshell/package.json")
    expect(pkg.name).toBe("@huynle/hub-runtime-openshell")
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe("module")
    expect(pkg.version).toBe(json("package.json").version)
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
  })

  test("is type-checked with the repository", () => {
    const include: string[] = json("tsconfig.json").include
    expect(include).toContain("packages/runtime-openshell/src")
    expect(include).toContain("packages/runtime-openshell/test")
  })

  test("its index exports the CLI client", async () => {
    const index = await import("../src/index.ts")
    expect(typeof index.OpenShellCli).toBe("function")
    expect(typeof index.OpenShellError).toBe("function")
  })
})
