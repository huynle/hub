// The SDK's Decision verbs (design §12.1): ask @me with Decision fields (options, recommendation, urgency, tier,
// deadline, onTimeout, about), decisions/decision reads on /api/agent, and answerDecision on the console route
// (a device token; its {error, code} envelope becomes a HubError too).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { HubClient, isHubError } from "../src/index.ts"
import { fakeHub } from "./fake-hub.ts"

const hub = fakeHub()
afterAll(() => hub.stop())
afterEach(() => {
  for (const key of Object.keys(hub.routes)) delete hub.routes[key]
  hub.seen.length = 0
})

const client = () => new HubClient({ url: hub.url, token: "tok" })
const seen = () => hub.seen.map(({ method, path, body }) => ({ method, path, ...(body !== undefined ? { body } : {}) }))
const message = (extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  kind: "ask",
  from: { kind: "session", sessionID: "ses_1" },
  to: "@me",
  recipient: { kind: "user" },
  text: "Proceed?",
  state: "open",
  at: 1,
  hop: 0,
  ...extra,
})
const decision = (extra: Record<string, unknown> = {}) => ({
  id: "dec_1",
  messageID: "msg_1",
  from: { kind: "session", sessionID: "ses_1" },
  about: ["ses_1"],
  sessionID: "ses_1",
  question: "Proceed?",
  options: [{ id: "go", label: "Proceed" }, { id: "hold", label: "Hold", safe: true }],
  urgency: "high",
  tier: "confirm",
  state: "open",
  at: 1,
  expiresAt: 2,
  ...extra,
})

describe("ask @me", () => {
  test("sends the Decision fields as the hub expects (deadline in seconds) and answers the Decision", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: message(), decision: decision() }, { status: 201 })
    const asked = await client().ask("@me", "Proceed?", {
      options: [{ id: "go", label: "Proceed" }, { id: "hold", label: "Hold", safe: true }],
      recommendation: { option: "hold", why: "readers left" },
      urgency: "high",
      tier: "tap",
      deadline: 7200,
      onTimeout: "hold",
      about: ["@api"],
    })
    expect(asked.decision?.id).toBe("dec_1")
    expect(seen()).toEqual([
      {
        method: "POST",
        path: "/api/agent/ask",
        body: {
          to: "@me",
          text: "Proceed?",
          options: [{ id: "go", label: "Proceed" }, { id: "hold", label: "Hold", safe: true }],
          recommendation: { option: "hold", why: "readers left" },
          urgency: "high",
          tier: "tap",
          deadline: 7200,
          onTimeout: "hold",
          about: ["@api"],
        },
      },
    ])
  })

  test("a long wait keeps the Decision from the first answer while it polls the ask", async () => {
    hub.routes["POST /api/agent/ask"] = () => Response.json({ message: message(), decision: decision() }, { status: 201 })
    hub.routes["GET /api/agent/messages/msg_1"] = () => Response.json({ message: message({ state: "answered" }), answer: message({ id: "msg_2", kind: "reply", text: "Decision dec_1: Hold [hold]" }) })
    const asked = await client().ask("@me", "Proceed?", { options: [{ id: "go", label: "Go" }], wait: 90 })
    expect(asked).toMatchObject({ message: { state: "answered" }, answer: { id: "msg_2" }, decision: { id: "dec_1" } })
  })
})

describe("reading and answering", () => {
  test("decisions (state filter) and decision(id) on /api/agent", async () => {
    hub.routes["GET /api/agent/decisions"] = () => Response.json({ decisions: [decision()] })
    hub.routes["GET /api/agent/decisions/dec_1"] = () => Response.json({ decision: decision() })
    expect((await client().decisions({ state: "open" })).decisions.map((d) => d.id)).toEqual(["dec_1"])
    expect((await client().decision("dec_1")).decision.id).toBe("dec_1")
    expect(hub.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/agent/decisions?state=open", "GET /api/agent/decisions/dec_1"])
  })

  test("answerDecision posts {option, text} to the console route; its 409 gone envelope is a HubError", async () => {
    hub.routes["POST /api/decisions/dec_1/answer"] = () => Response.json({ decision: decision({ state: "answered", answer: { option: "go", answeredBy: "user", at: 3 } }) })
    expect((await client().answerDecision("dec_1", { option: "go", text: "ship" })).decision.state).toBe("answered")
    expect(seen()).toEqual([{ method: "POST", path: "/api/decisions/dec_1/answer", body: { option: "go", text: "ship" } }])
    hub.routes["POST /api/decisions/dec_1/answer"] = () => Response.json({ error: "The decision is already answered or expired", code: "gone" }, { status: 409 })
    const error = await client().answerDecision("dec_1", { option: "go" }).catch((e) => e)
    expect(isHubError(error, "gone")).toBe(true)
    expect(error.status).toBe(409)
    expect(error.message).toBe("The decision is already answered or expired")
  })
})
