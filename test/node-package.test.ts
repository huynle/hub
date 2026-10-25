// `hub node` (packages/node, @huynle/hub-node) and the Runtime interface it implements (packages/runtime-sdk,
// @huynle/hub-runtime-sdk) are private workspace packages shipped as sources inside @huynle/hub, like the SDK.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"))
const main = json("package.json")

for (const [dir, name] of [
  ["runtime-sdk", "@huynle/hub-runtime-sdk"],
  ["node", "@huynle/hub-node"],
] as const) {
  describe(`${dir} workspace package`, () => {
    test("is private, ESM, at the hub's version, without dependencies, and exports its TypeScript source", () => {
      const file = path.join(root, "packages", dir, "package.json")
      expect(existsSync(file)).toBe(true)
      const pkg = JSON.parse(readFileSync(file, "utf8"))
      expect(pkg.name).toBe(name)
      expect(pkg.private).toBe(true)
      expect(pkg.type).toBe("module")
      expect(pkg.version).toBe(main.version)
      expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
      expect(pkg.dependencies ?? {}).toEqual({})
      expect(existsSync(path.join(root, "packages", dir, "src", "index.ts"))).toBe(true)
    })

    test("is a workspace of the hub", () => {
      expect(main.workspaces).toContain(`packages/${dir}`)
    })

    test("is shipped in the hub's npm package", () => {
      expect(main.files).toContain(`packages/${dir}/src`)
      expect(main.files).toContain(`packages/${dir}/package.json`)
    })

    test("is typechecked with its tests", () => {
      const tsconfig = json("tsconfig.json")
      expect(tsconfig.include).toContain(`packages/${dir}/src`)
      expect(tsconfig.include).toContain(`packages/${dir}/test`)
    })

    test("is in the lockfile", () => {
      const lock = json("package-lock.json")
      expect(lock.packages[`packages/${dir}`]?.name).toBe(name)
      expect(lock.packages[`node_modules/${name}`]?.link).toBe(true)
    })
  })
}

test("the node imports the runtime SDK and the protocol by relative path, never by package name", () => {
  const index = readFileSync(path.join(root, "packages", "node", "src", "index.ts"), "utf8")
  expect(index).not.toContain("@huynle/hub-runtime-sdk")
  expect(index).not.toContain("@huynle/hub-protocol")
})
