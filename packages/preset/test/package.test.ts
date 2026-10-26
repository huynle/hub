// The preset spoke (@huynle/hub-preset): a private workspace package shipped inside @huynle/hub, built on the spoke
// SDK. It imports the protocol and spoke SDK packages, the node's read-only spoke credentials and its own official
// presets (data); never the hub (src/central) or the OpenCode spoke.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const pkgDir = path.join(import.meta.dir, "..")
const root = path.join(pkgDir, "..", "..")
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))

const ALLOWED = [
  /^node:/,
  /^\.\/[\w-]+\.ts$/,
  /^\.\.\/package\.json$/,
  /^\.\.\/presets\/[\w.-]+\.json$/,
  /^\.\.\/\.\.\/(protocol|spoke-sdk)\/src\//,
  /^\.\.\/\.\.\/node\/src\/config\.ts$/,
  /^\.\.\/\.\.\/\.\.\/src\/config\.ts$/,
]

describe("preset workspace package", () => {
  test("is private, ESM, exports its TypeScript source, at the hub's version", () => {
    const pkg = json(path.join(pkgDir, "package.json"))
    expect(pkg.name).toBe("@huynle/hub-preset")
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe("module")
    expect(pkg.version).toBe(json(path.join(root, "package.json")).version)
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
  })

  test("is a workspace of the hub, shipped in its npm package (source and presets) and type-checked", () => {
    const main = json(path.join(root, "package.json"))
    expect(main.workspaces).toContain("packages/preset")
    expect(main.files).toContain("packages/preset/src")
    expect(main.files).toContain("packages/preset/presets")
    expect(main.files).toContain("packages/preset/package.json")
    const tsconfig = json(path.join(root, "tsconfig.json"))
    for (const dir of ["src", "test", "fixtures"]) expect(tsconfig.include).toContain(`packages/preset/${dir}`)
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
    expect(dockerfile.split("COPY packages/preset/package.json ./packages/preset/").length - 1).toBe(2)
    const lock = json(path.join(root, "package-lock.json"))
    expect(lock.packages["packages/preset"]?.name).toBe("@huynle/hub-preset")
  })

  test("imports only what it is allowed to", () => {
    for (const dir of ["src", "fixtures"]) {
      const full = path.join(pkgDir, dir)
      for (const file of readdirSync(full).filter((f) => f.endsWith(".ts"))) {
        const source = readFileSync(path.join(full, file), "utf8")
        for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
          const spec = match[1]!
          const ok = ALLOWED.some((rule) => rule.test(spec)) || (dir === "fixtures" && /^\.\.\/(src\/[\w-]+\.ts|\.\.\/(testkit)\/src\/)/.test(spec))
          expect({ file, spec, ok }).toEqual({ file, spec, ok: true })
        }
      }
    }
  })
})
