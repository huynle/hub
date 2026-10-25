// The service worker's decision notifications (P3-T8): the push carries only {kind, sessionID, decisionID}; for an
// escalation (a Decision with an action) the worker fetches it with the device cookie and shows the agent's
// recommendation ("@orchestrator recommends Approve once: only runs tests"). Other Decisions, closed ones and failed
// fetches keep the generic body. Runs web/public/sw.js against a fake service-worker global.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const SOURCE = readFileSync(path.join(import.meta.dir, "../web/public/sw.js"), "utf8")

async function push(data: Record<string, unknown>, decision: unknown, status = 200) {
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
    const { shown } = await push(PUSH, { ...ESCALATION, from: { kind: "app", tokenID: "tok_1", label: "concierge" }, recommendation: { option: "approve" } })
    expect(shown[0]!.options.body).toBe("app concierge recommends Approve once")
  })

  test("plain Decisions, closed escalations and failed fetches keep the generic body", async () => {
    const { action: _action, ...plain } = ESCALATION
    for (const [decision, status] of [[plain, 200], [{ ...ESCALATION, state: "closed" }, 200], [ESCALATION, 403]] as const) {
      const { shown } = await push(PUSH, decision, status)
      expect(shown[0]!.options.body).toBe(PUSH.body)
    }
  })
})
