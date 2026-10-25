// The hub's API client lives in the private workspace package packages/sdk (@huynle/hub-sdk). The CLI is built on it
// and the published @huynle/hub ships its sources, so the plugin can import it by relative path (it cannot import
// packages/cli/src, which is not shipped).
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"))
const main = json("package.json")
const pkgFile = path.join(root, "packages", "sdk", "package.json")

describe("sdk workspace package", () => {
  test("is private, ESM, at the hub's version, and exports its TypeScript source", () => {
    expect(existsSync(pkgFile)).toBe(true)
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"))
    expect(pkg.name).toBe("@huynle/hub-sdk")
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe("module")
    expect(pkg.version).toBe(main.version)
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  test("is a workspace of the hub", () => {
    expect(main.workspaces).toContain("packages/sdk")
  })

  test("is shipped in the hub's npm package", () => {
    expect(main.files).toContain("packages/sdk/src")
    expect(main.files).toContain("packages/sdk/package.json")
  })

  test("is typechecked with its tests", () => {
    const tsconfig = json("tsconfig.json")
    expect(tsconfig.include).toContain("packages/sdk/src")
    expect(tsconfig.include).toContain("packages/sdk/test")
  })
})
