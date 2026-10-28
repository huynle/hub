// The service worker's decision notifications (P3-T8): the push carries only {kind, sessionID, decisionID}; for an
// escalation (a Decision with an action) the worker fetches it with the device cookie and shows the agent's
// recommendation ("@orchestrator recommends Approve once: only runs tests"). Other Decisions, closed ones and failed
// fetches keep the generic body. Runs web/public/sw.js against a fake service-worker global.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const SOURCE = readFileSync(path.join(import.meta.dir, "../web/public/sw.js"), "utf8")

async function push(data: Record<string, unknown>, decision: unknown, status = 200, routes: Record<string, unknown> = {}) {
  const listeners = new Map<string, (event: any) => void>()
  const shown: Array<{ title: string; options: any }> = []
  const fetched: string[] = []
  const self = {
    addEventListener: (type: string, fn: (event: any) => void) => void listeners.set(type, fn),
    registration: { showNotification: async (title: string, options: any) => void shown.push({ title, options }) },
    clients: { claim: async () => {}, matchAll: async () => [] },
    skipWaiting: () => {},
    location: { origin: "http://hub.test" },
  }
  const fakeFetch = async (url: string) => {
    fetched.push(url)
    if (url in routes) return Response.json(routes[url])
    return new Response(JSON.stringify({ decision }), { status })
  }
  new Function("self", "fetch", SOURCE)(self, fakeFetch)
  let done: Promise<unknown> = Promise.resolve()
  listeners.get("push")!({ data: { json: () => data, text: () => JSON.stringify(data) }, waitUntil: (p: Promise<unknown>) => void (done = p) })
  await done
  return { shown, fetched }
}

const PUSH = { kind: "decision", sessionID: "ses_1", title: "Worker · Decision", body: "A decision waits for you. Tap to answer.", decisionID: "dec_abc" }
const ESCALATION = {
  id: "dec_abc",
  state: "open",
  from: { kind: "session", sessionID: "ses_orch", name: "orchestrator" },
  options: [{ id: "approve", label: "Approve once" }, { id: "deny", label: "Deny", safe: true }],
  recommendation: { option: "approve", why: "only runs tests" },
  action: { kind: "permission", requestID: "per_1" },
}

describe("decision pushes", () => {
  test("an open escalation shows who recommends what, and why", async () => {
    const { shown, fetched } = await push(PUSH, ESCALATION)
    expect(fetched).toEqual(["/api/decisions/dec_abc"])
    expect(shown[0]!.options.body).toBe("@orchestrator recommends Approve once: only runs tests")
  })

  test("an app's escalation names the app; no reason, no colon", async () => {
    const { shown } = await push(PUSH, { ...ESCALATION, from: { kind: "app", tokenID: "tok_1", label: "assistant-app" }, recommendation: { option: "approve" } })
    expect(shown[0]!.options.body).toBe("app assistant-app recommends Approve once")
  })

  test("plain Decisions, closed escalations and failed fetches keep the generic body", async () => {
    const { action: _action, ...plain } = ESCALATION
    for (const [decision, status] of [[plain, 200], [{ ...ESCALATION, state: "closed" }, 200], [ESCALATION, 403]] as const) {
      const { shown } = await push(PUSH, decision, status)
      expect(shown[0]!.options.body).toBe(PUSH.body)
    }
  })

  test("a tap-tier escalation push offers no quick answers, only Open", async () => {
    const { shown } = await push(PUSH, { ...ESCALATION, tier: "tap" })
    expect(shown[0]!.options.actions).toEqual([{ action: "open", title: "Open" }])
  })
})

describe("permission pushes of escalated requests", () => {
  const PERMISSION = { kind: "permission", sessionID: "ses_1", requestID: "per_1", title: "Worker · Permission", body: "Permission needed" }
  const session = (recommendation?: unknown) => ({
    blockers: [{ kind: "permission", id: "per_1", summary: "bash: bun test", ...(recommendation ? { recommendation } : {}) }],
  })
  const quick = [
    { action: "allow-once", title: "Allow once" },
    { action: "reject", title: "Reject" },
  ]

  test("a plain permission keeps Allow once / Reject", async () => {
    const { shown } = await push(PERMISSION, undefined, 200, { "/api/sessions/ses_1": session() })
    expect(shown[0]!.options.actions).toEqual(quick)
    expect(shown[0]!.options.body).toBe("bash: bun test")
  })

  test("escalated in a confirm-tier Decision: the quick answers stay", async () => {
    const { shown } = await push(PERMISSION, { ...ESCALATION, tier: "confirm" }, 200, { "/api/sessions/ses_1": session({ by: "@orchestrator", recommends: "approve", decisionID: "dec_abc" }) })
    expect(shown[0]!.options.actions).toEqual(quick)
  })

  test("escalated in a tap-tier Decision: no Allow once / Reject (answer by tapping in the console)", async () => {
    const { shown, fetched } = await push(PERMISSION, { ...ESCALATION, tier: "tap" }, 200, { "/api/sessions/ses_1": session({ by: "@orchestrator", recommends: "approve", decisionID: "dec_abc" }) })
    expect(fetched).toContain("/api/decisions/dec_abc")
    expect(shown[0]!.options.actions).toEqual([{ action: "open", title: "Open" }])
    expect(shown[0]!.options.body).toBe("bash: bun test")
  })

  test("the escalation cannot be read: no quick answers either (fail closed)", async () => {
    const { shown } = await push(PERMISSION, undefined, 403, { "/api/sessions/ses_1": session({ by: "@orchestrator", recommends: "approve", decisionID: "dec_abc" }) })
    expect(shown[0]!.options.actions).toEqual([{ action: "open", title: "Open" }])
  })
})
