import { describe, expect, test } from "bun:test"
import { encode, parseServerMessage, requestFeatures } from "../../protocol/src/index.ts"
import { ALL_OPS, featureProbes, judgeProbe, sampleRequest } from "../src/features.ts"

const ctx = { sessionID: "ses_cf1", directory: "/w", hubURL: "http://127.0.0.1:1", sessionToken: "hubs_x", actToken: "huba_x" }

describe("feature honesty: probes", () => {
  test("every op has a sample request the spoke parses (else it would drop it unanswered)", () => {
    expect(ALL_OPS.length).toBe(23)
    for (const op of ALL_OPS) {
      const req = sampleRequest(op, ctx)
      expect({ op, parsed: parseServerMessage(encode({ t: "req", id: "x", req })) !== undefined }).toEqual({ op, parsed: true })
    }
  })

  test("announced ops are probed to be served, every other op (and unannounced options) to be refused", () => {
    const probes = featureProbes(new Set(["permission", "stop", "deliver", "sessionTokens", "actTokens"]), ctx)
    const serve = probes.filter((p) => p.expect === "serve").map((p) => p.label)
    expect(serve.sort()).toEqual(["actTokens", "deliver", "permission", "sessionTokens", "stop"])
    const refuse = probes.filter((p) => p.expect === "refuse").map((p) => p.label)
    expect(refuse).toContain("turn")
    expect(refuse).toContain("setModelPrefs")
    expect(refuse).toContain("permission+permissionMessage")
    expect(refuse).toContain("deliver+hubPrompt")
    expect(refuse).toContain("create+launch")
    for (const p of probes) expect(requestFeatures(p.req).every((f) => ["permission", "stop", "deliver", "sessionTokens", "actTokens"].includes(f))).toBe(p.expect === "serve")
  })

  test("option probes are served when their feature is announced too", () => {
    const probes = featureProbes(new Set(["permission", "permissionMessage", "deliver", "hubPrompt"]), ctx)
    expect(probes.find((p) => p.label === "permission+permissionMessage")?.expect).toBe("serve")
    expect(probes.find((p) => p.label === "deliver+hubPrompt")?.expect).toBe("serve")
  })
})

describe("feature honesty: judging answers", () => {
  const refuse = { label: "diff", req: sampleRequest("diff", ctx), expect: "refuse" as const }
  const serve = { label: "deliver", req: sampleRequest("deliver", ctx), expect: "serve" as const }

  test("an unannounced op must be refused with an error, never a silent ok or no answer", () => {
    expect(judgeProbe(refuse, { ok: false, error: "not announced" })).toBeUndefined()
    expect(judgeProbe(refuse, { ok: true, result: {} })).toMatch(/unannounced "diff".*ok/)
    expect(judgeProbe(refuse, { ok: false })).toMatch(/without an error/)
    expect(judgeProbe(refuse, undefined)).toMatch(/no answer/)
  })

  test("an announced op succeeds with a well-formed result or fails with a well-formed error", () => {
    expect(judgeProbe(serve, { ok: true, result: { delivered: "queued" } })).toBeUndefined()
    expect(judgeProbe(serve, { ok: false, error: "session busy" })).toBeUndefined()
    expect(judgeProbe(serve, { ok: true, result: { delivered: "maybe" } })).toMatch(/malformed result/)
    expect(judgeProbe(serve, { ok: false, error: "" })).toMatch(/without an error/)
    expect(judgeProbe(serve, undefined)).toMatch(/no answer/)
  })
})
