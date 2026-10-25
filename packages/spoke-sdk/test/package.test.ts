// The spoke SDK (@huynle/hub-spoke-sdk): a private workspace package shipped inside @huynle/hub. It holds the
// harness-neutral parts of a spoke (connection, enrollment, tokens, idempotent deliver, prompt references, activity
// compaction) so spokes of other harnesses reuse them; the OpenCode spoke's src/spoke files re-export them.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import * as protocol from "../../protocol/src/index.ts"
import * as sdk from "../src/index.ts"

const pkgDir = path.join(import.meta.dir, "..")
const root = path.join(pkgDir, "..", "..")
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))

describe("spoke SDK workspace package", () => {
  test("is private, ESM, and exports its TypeScript source", () => {
    const pkg = json(path.join(pkgDir, "package.json"))
    expect(pkg.name).toBe("@huynle/hub-spoke-sdk")
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe("module")
    expect(pkg.version).toBe(json(path.join(root, "package.json")).version)
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
  })

  test("is a workspace of the hub, shipped in its npm package and type-checked", () => {
    const main = json(path.join(root, "package.json"))
    expect(main.workspaces).toContain("packages/spoke-sdk")
    expect(main.files).toContain("packages/spoke-sdk/src")
    expect(main.files).toContain("packages/spoke-sdk/package.json")
    const tsconfig = json(path.join(root, "tsconfig.json"))
    expect(tsconfig.include).toContain("packages/spoke-sdk/src")
    expect(tsconfig.include).toContain("packages/spoke-sdk/test")
  })

  test("imports only its own files, the protocol and SDK packages, and node builtins", () => {
    const srcDir = path.join(pkgDir, "src")
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(path.join(srcDir, file), "utf8")
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
        const spec = match[1]!
        const ok = spec.startsWith("node:") || /^\.\/[\w-]+\.ts$/.test(spec) || spec.startsWith("../../protocol/src/") || spec.startsWith("../../sdk/src/")
        expect({ file, spec, ok }).toEqual({ file, spec, ok: true })
      }
    }
  })

  test("re-exports the protocol's activity compaction", () => {
    expect(sdk.compactActivity).toBe(protocol.compactActivity)
    expect(sdk.summarizeToolInput).toBe(protocol.summarizeToolInput)
  })
})

describe("the OpenCode spoke's files re-export the SDK", () => {
  test("connection, enrollment and session tokens", async () => {
    const client = await import("../../../src/spoke/client.ts")
    expect(client.SpokeConnection).toBe(sdk.SpokeConnection)
    expect(client.backoffDelay).toBe(sdk.backoffDelay)
    expect(client.retryAfterDelay).toBe(sdk.retryAfterDelay)
    expect(client.wsURL).toBe(sdk.wsURL)
    const enroll = await import("../../../src/spoke/enroll.ts")
    expect(enroll.startEnrollment).toBe(sdk.startEnrollment)
    expect(enroll.pollEnrollment).toBe(sdk.pollEnrollment)
    const tokens = await import("../../../src/spoke/session-tokens.ts")
    expect(tokens.SessionTokenStore).toBe(sdk.SessionTokenStore)
  })

  test("delivery ledger, inbox origins and the prompt envelope", async () => {
    const deliver = await import("../../../src/spoke/deliver.ts")
    expect(deliver.DeliveryLedger).toBe(sdk.DeliveryLedger)
    expect(deliver.InboxOrigins).toBe(sdk.InboxOrigins)
    expect(deliver.renderPromptEnvelope).toBe(sdk.renderPromptEnvelope)
    expect(deliver.deliverText).toBe(sdk.deliverText)
    const conversation = await import("../../../src/spoke/conversation.ts")
    expect(conversation.PROMPT_SOURCE).toBe(sdk.PROMPT_SOURCE)
    expect(conversation.isHubPrompt).toBe(sdk.isHubPrompt)
  })

  test("prompt references (find, resolve, render)", async () => {
    const refs = await import("../../../src/spoke/prompt-refs.ts")
    expect(refs.findReferences).toBe(sdk.findReferences)
    expect(refs.resolveReferences).toBe(sdk.resolveReferences)
    expect(refs.renderReferences).toBe(sdk.renderReferences)
    // The OpenCode hook stays in the spoke (it edits OpenCode's prompt event).
    expect(typeof refs.PromptReferences).toBe("function")
    expect("PromptReferences" in sdk).toBe(false)
  })

  test("every shipped file exists", () => {
    for (const f of ["src/index.ts", "package.json"]) expect(existsSync(path.join(pkgDir, f))).toBe(true)
  })
})
