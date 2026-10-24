// The /api/agent error envelope (src/central/agent/errors.ts): {error: {code, message, hint?, ...extra}}.
import { describe, expect, test } from "bun:test"
import { AGENT_ERROR_STATUS, AgentError, agentError, agentFailure } from "../src/central/agent/errors"

describe("agent error envelope", () => {
  test("every design §8 code plus unauthorized, token_expired and invalid has an HTTP status", () => {
    expect(AGENT_ERROR_STATUS).toEqual({
      invalid: 400,
      unauthorized: 401,
      token_expired: 401,
      needs_user: 403,
      forbidden: 403,
      not_found: 404,
      ambiguous: 409,
      name_taken: 409,
      gone: 410,
      unsupported: 422,
      paused: 423,
      rate_limited: 429,
      internal: 500,
      offline: 503,
    })
  })

  test("agentError: status from the code, hint and extra fields in the envelope, never cached", async () => {
    const res = agentError(new AgentError("ambiguous", "Several sessions match @api", { hint: "Use @api@laptop", extra: { candidates: ["a", "b"] } }))
    expect(res.status).toBe(409)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ error: { code: "ambiguous", message: "Several sessions match @api", hint: "Use @api@laptop", candidates: ["a", "b"] } })
  })

  test("extra fields cannot overwrite code or message", async () => {
    const res = agentError(new AgentError("gone", "Already answered", { extra: { code: "x", message: "y" } }))
    expect(await res.json()).toEqual({ error: { code: "gone", message: "Already answered" } })
  })

  test("rate_limited with retryAfter sets Retry-After", async () => {
    const res = agentError(new AgentError("rate_limited", "Slow down", { extra: { retryAfter: 7 } }))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("7")
    expect((await res.json()).error.retryAfter).toBe(7)
  })

  test("agentFailure: AgentError as is, bad JSON as invalid, anything else internal without its message", async () => {
    expect(await agentFailure(new AgentError("not_found", "No such session")).json()).toEqual({ error: { code: "not_found", message: "No such session" } })
    const bad = agentFailure(new SyntaxError("Unexpected token"))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe("invalid")
    const original = console.error
    console.error = () => {}
    try {
      const boom = agentFailure(new Error("secret internals"))
      expect(boom.status).toBe(500)
      expect(await boom.json()).toEqual({ error: { code: "internal", message: "Internal error" } })
    } finally {
      console.error = original
    }
  })
})
