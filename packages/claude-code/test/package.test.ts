// The Claude Code spoke (@huynle/hub-claude-code): a private workspace package shipped inside @huynle/hub, built on
// the spoke SDK. It imports the protocol, SDK and spoke SDK packages, the hub CLI's MCP tools, the node's read-only
// spoke credentials, node.json and executable lookup, and the hub's env and config path helpers; never the hub (src/central) or the OpenCode spoke.
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
  /^\.\.\/\.\.\/(protocol|sdk|spoke-sdk)\/src\//,
  /^\.\.\/\.\.\/cli\/src\/(mcp|http|credentials)\.ts$/,
  /^\.\.\/\.\.\/node\/src\/(config|harnesses)\.ts$/,
  /^\.\.\/\.\.\/\.\.\/src\/(env|migrate|config)\.ts$/,
]

describe("claude-code workspace package", () => {
  test("is private, ESM, exports its TypeScript source, at the hub's version", () => {
    const pkg = json(path.join(pkgDir, "package.json"))
    expect(pkg.name).toBe("@huynle/hub-claude-code")
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe("module")
    expect(pkg.version).toBe(json(path.join(root, "package.json")).version)
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
  })

  test("is a workspace of the hub, shipped in its npm package and type-checked", () => {
    const main = json(path.join(root, "package.json"))
    expect(main.workspaces).toContain("packages/claude-code")
    expect(main.files).toContain("packages/claude-code/src")
    expect(main.files).toContain("packages/claude-code/package.json")
    const tsconfig = json(path.join(root, "tsconfig.json"))
    expect(tsconfig.include).toContain("packages/claude-code/src")
    expect(tsconfig.include).toContain("packages/claude-code/test")
  })

  test("imports only what it is allowed to", () => {
    const srcDir = path.join(pkgDir, "src")
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(path.join(srcDir, file), "utf8")
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
        const spec = match[1]!
        expect({ file, spec, ok: ALLOWED.some((rule) => rule.test(spec)) }).toEqual({ file, spec, ok: true })
      }
    }
  })
})
