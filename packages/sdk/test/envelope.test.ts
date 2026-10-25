// The pure envelope renderer/sanitiser and the address parser live in the SDK, so the plugin's hub tool, its
// prompt-reference hook and `hub mcp` render and parse exactly as the hub does without importing hub internals.
// The hub's modules re-export the very same functions (behaviour checks are in test/central-agent-envelope.test.ts
// and test/central-agent-names.test.ts).
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import * as hubEnvelope from "../../../src/central/agent/envelope"
import * as hubNames from "../../../src/central/agent/names"
import * as sdk from "../src/index.ts"

const root = path.join(import.meta.dir, "..", "..", "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")
// Looked up by name so this file typechecks before the helpers exist.
const fn = (name: string): unknown => (sdk as Record<string, unknown>)[name]

describe("SDK envelope and address helpers", () => {
  test("the SDK exports the envelope helpers and the address parser", () => {
    for (const name of ["sanitizeText", "sanitizeLabel", "partyLabel", "renderEnvelope", "renderPrimer", "parseAddress", "validName"]) expect(typeof fn(name)).toBe("function")
    expect(fn("LABEL_MAX")).toBe(120)
    expect(fn("NAME_MAX")).toBe(40)
  })

  test("the hub's envelope and names modules re-export the same functions", () => {
    expect(hubEnvelope.sanitizeText).toBe(fn("sanitizeText") as never)
    expect(hubEnvelope.sanitizeLabel).toBe(fn("sanitizeLabel") as never)
    expect(hubEnvelope.partyLabel).toBe(fn("partyLabel") as never)
    expect(hubEnvelope.renderEnvelope).toBe(fn("renderEnvelope") as never)
    expect(hubEnvelope.renderPrimer).toBe(fn("renderPrimer") as never)
    expect(hubNames.parseAddress).toBe(fn("parseAddress") as never)
    expect(hubNames.validName).toBe(fn("validName") as never)
  })

  test("the SDK sources import nothing outside the package", () => {
    const dir = path.join(root, "packages", "sdk", "src")
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) expect(read(`packages/sdk/src/${file}`)).not.toMatch(/from "\.\.\//)
  })

  test("the plugin and hub mcp take the helpers from the SDK, not from the hub's internals", () => {
    for (const file of ["src/spoke/hub-tool.ts", "src/spoke/prompt-refs.ts", "src/spoke/hub-rpc.ts", "packages/cli/src/mcp.ts"])
      expect({ file, imports: /from "[^"]*central\/agent\//.test(read(file)) }).toEqual({ file, imports: false })
  })
})
