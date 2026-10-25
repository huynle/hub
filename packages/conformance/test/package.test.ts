// The conformance suite (@huynle/hub-conformance): a private workspace package that runs a spoke (through its harness
// driver) against a recording hub and checks it keeps the spoke protocol's promises. A dev-time package like the
// testkit it builds on: not shipped inside @huynle/hub's npm package or image.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const pkgDir = path.join(import.meta.dir, "..")
const root = path.join(pkgDir, "..", "..")
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))

describe("conformance workspace package", () => {
  test("is private, ESM, exports its TypeScript source and has the hub-conformance bin", () => {
    const pkg = json(path.join(pkgDir, "package.json"))
    expect(pkg.name).toBe("@huynle/hub-conformance")
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe("module")
    expect(pkg.version).toBe(json(path.join(root, "package.json")).version)
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
    expect(pkg.bin).toEqual({ "hub-conformance": "./src/cli.ts" })
  })

  test("is a workspace of the hub and type-checked, but not shipped in its npm package", () => {
    const main = json(path.join(root, "package.json"))
    expect(main.workspaces).toContain("packages/conformance")
    expect(main.files.some((f: string) => f.startsWith("packages/conformance"))).toBe(false)
    const tsconfig = json(path.join(root, "tsconfig.json"))
    for (const dir of ["src", "test", "fixtures"]) expect(tsconfig.include).toContain(`packages/conformance/${dir}`)
  })

  test("is linked in the lockfile and its manifest is copied into the Dockerfile's install stages", () => {
    const lock = json(path.join(root, "package-lock.json"))
    expect(lock.packages[""].workspaces).toContain("packages/conformance")
    expect(lock.packages["node_modules/@huynle/hub-conformance"]).toEqual({ resolved: "packages/conformance", link: true })
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
    const copies = dockerfile.split("\n").filter((l) => l.trim() === "COPY packages/conformance/package.json ./packages/conformance/")
    expect(copies.length).toBe(2)
  })

  test("src imports only its own files, the protocol, testkit and node builtins; fixtures add the spoke SDK", () => {
    const allowed = (dir: string, spec: string) =>
      spec.startsWith("node:") ||
      /^\.\/[\w-]+\.ts$/.test(spec) ||
      spec.startsWith("../../protocol/src/") ||
      spec.startsWith("../../testkit/src/") ||
      (dir === "fixtures" && (spec.startsWith("../../spoke-sdk/src/") || spec.startsWith("../src/")))
    for (const dir of ["src", "fixtures"]) {
      if (!existsSync(path.join(pkgDir, dir))) continue
      const files = readdirSync(path.join(pkgDir, dir)).filter((f) => f.endsWith(".ts"))
      for (const file of files) {
        const source = readFileSync(path.join(pkgDir, dir, file), "utf8")
        for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
          const spec = match[1]!
          expect({ dir, file, spec, ok: allowed(dir, spec) }).toEqual({ dir, file, spec, ok: true })
        }
      }
    }
  })

  test("every exported file exists", () => {
    for (const f of ["src/index.ts", "src/cli.ts", "package.json"]) expect(existsSync(path.join(pkgDir, f))).toBe(true)
  })
})
