// The testkit (@huynle/hub-testkit): a private workspace package of test doubles for hub spokes, harness
// packages and conformance suites: a fake hub, fake spoke clients, stub model servers, a deny-all proxy and the
// harness driver protocol. It is a dev-time package: not shipped inside @huynle/hub's npm package or image.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const pkgDir = path.join(import.meta.dir, "..")
const root = path.join(pkgDir, "..", "..")
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))

describe("testkit workspace package", () => {
  test("is private, ESM, and exports its TypeScript source", () => {
    const pkg = json(path.join(pkgDir, "package.json"))
    expect(pkg.name).toBe("@huynle/hub-testkit")
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe("module")
    expect(pkg.version).toBe(json(path.join(root, "package.json")).version)
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
  })

  test("is a workspace of the hub and type-checked, but not shipped in its npm package", () => {
    const main = json(path.join(root, "package.json"))
    expect(main.workspaces).toContain("packages/testkit")
    expect(main.files.some((f: string) => f.startsWith("packages/testkit"))).toBe(false)
    const tsconfig = json(path.join(root, "tsconfig.json"))
    expect(tsconfig.include).toContain("packages/testkit/src")
    expect(tsconfig.include).toContain("packages/testkit/test")
  })

  test("is linked in the lockfile and its manifest is copied into the Dockerfile's install stages", () => {
    const lock = json(path.join(root, "package-lock.json"))
    expect(lock.packages[""].workspaces).toContain("packages/testkit")
    expect(lock.packages["node_modules/@huynle/hub-testkit"]).toEqual({ resolved: "packages/testkit", link: true })
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
    const copies = dockerfile.split("\n").filter((l) => l.trim() === "COPY packages/testkit/package.json ./packages/testkit/")
    expect(copies.length).toBe(2)
  })

  test("imports only its own files, the protocol, SDK and spoke SDK packages, and node builtins", () => {
    const srcDir = path.join(pkgDir, "src")
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(path.join(srcDir, file), "utf8")
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
        const spec = match[1]!
        const ok =
          spec.startsWith("node:") ||
          /^\.\/[\w-]+\.ts$/.test(spec) ||
          spec.startsWith("../../protocol/src/") ||
          spec.startsWith("../../sdk/src/") ||
          spec.startsWith("../../spoke-sdk/src/")
        expect({ file, spec, ok }).toEqual({ file, spec, ok: true })
      }
    }
  })

  test("the hub's test/spoke-fake.ts re-exports the fake hub under its old names", async () => {
    const testkit = await import("../src/index.ts")
    const old = await import("../../../test/spoke-fake.ts")
    expect(old.fakeCentral).toBe(testkit.fakeHub)
    expect(old.stopServer).toBe(testkit.stopServer)
    expect(old.freePort).toBe(testkit.freePort)
    expect(old.until).toBe(testkit.until)
    expect(old.EventQueue).toBe(testkit.EventQueue)
  })

  test("every shipped file exists", () => {
    for (const f of ["src/index.ts", "package.json"]) expect(existsSync(path.join(pkgDir, f))).toBe(true)
  })
})
