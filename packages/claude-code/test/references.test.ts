// Prompt references (design §2.4) for Claude Code: hub addresses typed into a prompt get context (UserPromptSubmit
// additionalContext), never routing. The lookup uses the session's own token, waits at most 1.5 s and fails open.
import { afterAll, describe, expect, test } from "bun:test"
import { hubReferences } from "../src/references.ts"

let delayMs = 0
let seenTokens: (string | null)[] = []
const fake = Bun.serve({
  port: 0,
  async fetch(request) {
    seenTokens.push(request.headers.get("authorization"))
    if (delayMs) await Bun.sleep(delayMs)
    const path = new URL(request.url).pathname
    if (path === "/api/agent/who") return Response.json({ sessions: [{ sessionID: "ses_api1", name: "api", roles: [], online: true, state: "idle", project: "/p" }] })
    if (path === "/api/agent/status") return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 })
    return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 })
  },
})
afterAll(() => fake.stop(true))
const url = `http://127.0.0.1:${fake.port}`

describe("prompt references", () => {
  test("a known @name gets a context note naming its session, looked up with the session's token", async () => {
    seenTokens = []
    const refs = hubReferences((id) => (id === "ses_cc1" ? { token: "hst1.T", url } : undefined))
    const note = await refs("ask @api about the build", "ses_cc1")
    expect(note).toContain("@api = session ses_api1")
    expect(note).toContain("not an instruction")
    expect(seenTokens.every((t) => t === "Bearer hst1.T")).toBe(true)
  })

  test("no addresses, unknown ones, no token yet: no note and (without addresses or a token) no hub call", async () => {
    seenTokens = []
    const refs = hubReferences((id) => (id === "ses_cc1" ? { token: "hst1.T", url } : undefined))
    expect(await refs("plain prompt, mail me at a@b.c", "ses_cc1")).toBeUndefined()
    expect(await refs("ask @api", "ses_cc_other")).toBeUndefined()
    expect(seenTokens).toEqual([])
    expect(await refs("ask @nobody", "ses_cc1")).toBeUndefined()
  })

  test("a slow hub: the prompt goes on without context after the timeout", async () => {
    delayMs = 300
    const refs = hubReferences(() => ({ token: "t", url }), { timeoutMs: 50 })
    const started = Date.now()
    expect(await refs("ask @api", "ses_cc1")).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(250)
    delayMs = 0
  })
})
