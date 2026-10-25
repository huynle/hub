import { describe, expect, test } from "bun:test"
import type { DeliverMeta } from "../src/protocol"
import { DeliveryLedger, deliverMetadata, harnessMessageID, InboxOrigins, planDelivery } from "../src/spoke/deliver"

const meta = (extra: Partial<DeliverMeta> = {}): DeliverMeta => ({ kind: "msg", from: "@api", to: "@@reviewer", ...extra })
const idle = { busy: false, formOpen: false, subagent: false }
const busy = { ...idle, busy: true }

describe("planDelivery", () => {
  test("an idle recipient gets a turn", () => {
    expect(planDelivery({ wake: true, meta: meta() }, idle)).toEqual({ delivery: "queue", resume: true, delivered: "turn" })
  })

  test("a plain msg to a busy recipient queues behind the running turn", () => {
    expect(planDelivery({ wake: true, meta: meta() }, busy)).toEqual({ delivery: "queue", resume: true, delivered: "queued" })
  })

  test("an ask to a busy recipient steers into the running turn", () => {
    expect(planDelivery({ wake: true, meta: meta({ kind: "ask" }) }, busy)).toEqual({ delivery: "steer", resume: true, delivered: "steer" })
  })

  test("the hub's delivery choice (urgent: steer) wins over the kind's default", () => {
    expect(planDelivery({ wake: true, meta: meta({ delivery: "steer" }) }, busy)).toMatchObject({ delivery: "steer", delivered: "steer" })
    expect(planDelivery({ wake: true, meta: meta({ kind: "ask", delivery: "queue" }) }, busy)).toMatchObject({ delivery: "queue", delivered: "queued" })
  })

  // A queued item gets its own model call once a turn ends (it wakes the session); a steered one without resume
  // waits for the next turn and arrives before its prompt (OpenCode 2.1.4, test/spoke-deliver.it.test.ts).
  test("wake:false admits without waking (steer, no resume) and reports queued, idle or busy", () => {
    expect(planDelivery({ wake: false, meta: meta() }, idle)).toEqual({ delivery: "steer", resume: false, delivered: "queued" })
    expect(planDelivery({ wake: false, meta: meta({ kind: "ask" }) }, busy)).toEqual({ delivery: "steer", resume: false, delivered: "queued" })
  })

  test("wake:false keeps the hub's explicit delivery choice", () => {
    expect(planDelivery({ wake: false, meta: meta({ delivery: "queue" }) }, idle)).toEqual({ delivery: "queue", resume: false, delivered: "queued" })
  })

  test("a subagent session is never woken", () => {
    expect(planDelivery({ wake: true, meta: meta() }, { ...idle, subagent: true })).toEqual({ delivery: "steer", resume: false, delivered: "queued" })
  })

  test("an open form retains the message (OpenCode holds it until the form is answered)", () => {
    expect(planDelivery({ wake: true, meta: meta({ kind: "ask" }) }, { busy: true, formOpen: true, subagent: false })).toEqual({ delivery: "steer", resume: true, delivered: "retained" })
  })
})

describe("harnessMessageID", () => {
  test("hub msg_ ids pass through unchanged", () => {
    expect(harnessMessageID("msg_7fA9bC0dE1fG2hI3jK4lM5")).toBe("msg_7fA9bC0dE1fG2hI3jK4lM5")
  })

  test("other ids map to a stable msg_hub id of id characters", () => {
    const a = harnessMessageID("app:tok/42")
    expect(a).toMatch(/^msg_hub[0-9a-f]{40}$/)
    expect(harnessMessageID("app:tok/42")).toBe(a)
    expect(harnessMessageID("app:tok/43")).not.toBe(a)
    expect(harnessMessageID("msg_with.dot")).toMatch(/^msg_hub[0-9a-f]{40}$/)
  })
})

describe("deliverMetadata", () => {
  test("marks the source and carries kind, from, to, messageID and replyTo only", () => {
    expect(deliverMetadata({ messageID: "msg_1", meta: meta({ kind: "reply", replyTo: "msg_0", delivery: "steer" }) })).toEqual({
      source: "hub",
      messageID: "msg_1",
      kind: "reply",
      from: "@api",
      to: "@@reviewer",
      replyTo: "msg_0",
    })
    expect(deliverMetadata({ messageID: "msg_1", meta: meta() })).toEqual({ source: "hub", messageID: "msg_1", kind: "msg", from: "@api", to: "@@reviewer" })
  })
})

describe("InboxOrigins", () => {
  const enqueued = (inboxID: string, item: unknown) => ({ type: "session.inbox.enqueued", data: { sessionID: "ses_a", inboxID, item } })

  test("user prompts are the user's, hub phone prompts included; hub synthetic messages are the hub's", () => {
    const origins = new InboxOrigins()
    origins.observe(enqueued("msg_typed", { type: "user", payload: { text: "hi" }, delivery: "steer" }))
    origins.observe(enqueued("msg_phone", { type: "user", payload: { text: "hi", metadata: { source: "hub", mode: "remote" } }, delivery: "steer" }))
    origins.observe(enqueued("msg_hubmsg", { type: "synthetic", payload: { text: "[hub] …", metadata: { source: "hub", messageID: "msg_hubmsg" } }, delivery: "queue" }))
    origins.observe(enqueued("msg_internal", { type: "synthetic", payload: { text: "note" }, delivery: "steer" }))
    origins.observe(enqueued("msg_compact", { type: "compaction", payload: {}, delivery: "queue" }))
    expect(origins.take("msg_typed")).toBe("user")
    expect(origins.take("msg_phone")).toBe("user")
    expect(origins.take("msg_hubmsg")).toBe("hub")
    expect(origins.take("msg_internal")).toBeUndefined()
    expect(origins.take("msg_compact")).toBeUndefined()
    expect(origins.take("msg_never_seen")).toBeUndefined()
  })

  test("a message the spoke delivered is the hub's even before its enqueued event; take forgets it", () => {
    const origins = new InboxOrigins()
    origins.hub("msg_sent")
    expect(origins.take("msg_sent")).toBe("hub")
    expect(origins.take("msg_sent")).toBeUndefined()
  })

  test("an enqueued user event never overrides a hub delivery with the same id", () => {
    const origins = new InboxOrigins()
    origins.hub("msg_sent")
    origins.observe(enqueued("msg_sent", { type: "user", payload: { text: "x" }, delivery: "queue" }))
    expect(origins.take("msg_sent")).toBe("hub")
  })

  test("remembers a bounded number of ids", () => {
    const origins = new InboxOrigins(3)
    for (const id of ["a", "b", "c", "d"]) origins.hub(id)
    expect(origins.take("a")).toBeUndefined()
    expect(origins.take("d")).toBe("hub")
  })
})

describe("DeliveryLedger", () => {
  test("a duplicate messageID is admitted once and gets the first result", async () => {
    const ledger = new DeliveryLedger()
    let calls = 0
    const send = async () => {
      calls++
      return { result: { delivered: "turn" as const, inboxID: "msg_1" }, resumed: true }
    }
    const [a, b] = await Promise.all([ledger.run("msg_1", true, send), ledger.run("msg_1", true, send)])
    expect(await ledger.run("msg_1", false, send)).toEqual({ delivered: "turn", inboxID: "msg_1" })
    expect(a).toEqual({ delivered: "turn", inboxID: "msg_1" })
    expect(b).toEqual(a)
    expect(calls).toBe(1)
  })

  test("a retry that asks to wake a message admitted without waking sends again (to wake it)", async () => {
    const ledger = new DeliveryLedger()
    const results = [
      { result: { delivered: "queued" as const }, resumed: false },
      { result: { delivered: "turn" as const }, resumed: true },
    ]
    let calls = 0
    const send = async () => results[calls++]!
    expect(await ledger.run("msg_1", false, send)).toEqual({ delivered: "queued" })
    expect(await ledger.run("msg_1", false, send)).toEqual({ delivered: "queued" })
    expect(calls).toBe(1)
    expect(await ledger.run("msg_1", true, send)).toEqual({ delivered: "turn" })
    expect(await ledger.run("msg_1", true, send)).toEqual({ delivered: "turn" })
    expect(calls).toBe(2)
  })

  test("a failed admission is not remembered, so the hub's retry is sent", async () => {
    const ledger = new DeliveryLedger()
    let calls = 0
    const send = async () => {
      if (calls++ === 0) throw new Error("OpenCode unavailable")
      return { result: { delivered: "turn" as const }, resumed: true }
    }
    await expect(ledger.run("msg_1", true, send)).rejects.toThrow("OpenCode unavailable")
    expect(await ledger.run("msg_1", true, send)).toEqual({ delivered: "turn" })
    expect(calls).toBe(2)
  })

  test("remembers a bounded number of messages", async () => {
    const ledger = new DeliveryLedger(2)
    let calls = 0
    const send = async () => {
      calls++
      return { result: { delivered: "turn" as const }, resumed: true }
    }
    for (const id of ["a", "b", "c"]) await ledger.run(id, true, send)
    await ledger.run("c", true, send)
    expect(calls).toBe(3)
    await ledger.run("a", true, send)
    expect(calls).toBe(4)
  })
})
