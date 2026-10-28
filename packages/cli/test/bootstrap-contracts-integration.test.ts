// Contract fixes found while integrating the bootstrap into the CLI (HBS-13).
import { describe, expect, test } from "bun:test"
import { ENVELOPE_SCHEMA, planDigest, validateEnvelope, type SetupPreview } from "../src/bootstrap/contracts/index.ts"
import { PLAN_LAUNCH_NODE, PREVIEW } from "./bootstrap/fixtures.ts"

const PREVIEW_DOC: SetupPreview = { schema: "hub.setup-preview", version: 1, plan: PLAN_LAUNCH_NODE, planDigest: planDigest(PLAN_LAUNCH_NODE), token: { ...PREVIEW, planDigest: planDigest(PLAN_LAUNCH_NODE) }, blockers: [], evidence: [] }

describe("the envelope of `setup preview --json` carries the SetupPreview", () => {
  test("a preview's /token (a preview token, not a credential) is allowed in the envelope's data", () => {
    expect(validateEnvelope({ schema: ENVELOPE_SCHEMA, version: 1, command: "setup preview", ok: true, data: PREVIEW_DOC }).ok).toBe(true)
  })

  test("only there: a token key anywhere else, or a credential-shaped token value, is still refused", () => {
    const codes = (v: unknown) => {
      const r = validateEnvelope(v)
      return r.ok ? [] : r.issues.map((i) => i.code)
    }
    expect(codes({ schema: ENVELOPE_SCHEMA, version: 1, command: "setup preview", ok: true, data: { token: "x" } })).toContain("secret")
    expect(codes({ schema: ENVELOPE_SCHEMA, version: 1, command: "setup preview", ok: true, data: { ...PREVIEW_DOC, token: { ...PREVIEW_DOC.token, nonce: "mt_abcdefghijklmnopqrst" } } })).toContain("secret")
    expect(codes({ schema: ENVELOPE_SCHEMA, version: 1, command: "setup preview", ok: true, data: { ...PREVIEW_DOC, extra: { token: "x" } } })).toContain("secret")
  })
})
