// The hub's live stream: event ids, replay after a reconnect (Last-Event-ID), lite and per-session streams.
import { afterEach, describe, expect, test } from "bun:test"
import { EventLog } from "../src/central/events-log"
import { harness, session, spoke, waitFor, type Harness } from "./central-harness"

describe("EventLog", () => {
  test("ids increase per user; since returns what came after an id, in order", () => {
    const log = new EventLog({ epoch: "e1" })
    const a1 = log.append("alice", { type: "status", n: 1 })
    log.append("bob", { type: "status", n: 9 })
    const a2 = log.append("alice", { type: "status", n: 2 })
    const a3 = log.append("alice", { type: "delta", n: 3 }, "dev_1")
    expect([a1, a2, a3]).toEqual(["e1.1", "e1.2", "e1.3"])
    expect(log.latest("alice")).toBe("e1.3")
    expect(log.since("alice", a1)!.map((e) => [e.id, e.message.n, e.exceptDevice])).toEqual([["e1.2", 2, undefined], ["e1.3", 3, "dev_1"]])
    expect(log.since("alice", a3)).toEqual([])
    expect(log.since("bob", "e1.1")).toEqual([])
  })

  test("users are isolated: one user's id never replays another's events", () => {
    const log = new EventLog({ epoch: "e1" })
    log.append("alice", { type: "status" })
    log.append("alice", { type: "status" })
    log.append("bob", { type: "status", secret: true })
    expect(log.since("bob", "e1.0")!.length).toBe(1)
    expect(JSON.stringify(log.since("alice", "e1.0"))).not.toContain("secret")
  })

  test("a gap is not covered for another epoch, a future id, an unknown user, or garbage", () => {
    const log = new EventLog({ epoch: "e1" })
    log.append("alice", { type: "status" })
    expect(log.since("alice", "e0.1")).toBeUndefined()
    expect(log.since("alice", "e1.7")).toBeUndefined()
    expect(log.since("carol", "e1.0")).toBeUndefined()
    expect(log.since("alice", "nonsense")).toBeUndefined()
    expect(log.latest("carol")).toBe("e1.0")
  })

  test("keeps at most `max` events per user: a gap older than that is not covered", () => {
    const log = new EventLog({ epoch: "e", max: 3 })
    for (let i = 0; i < 5; i++) log.append("alice", { type: "status", i })
    expect(log.since("alice", "e.1")).toBeUndefined()
    expect(log.since("alice", "e.2")!.map((e) => e.message.i)).toEqual([2, 3, 4])
  })

  test("drops events older than maxAgeMs: a gap reaching past them is not covered", () => {
    let t = 0
    const log = new EventLog({ epoch: "e", maxAgeMs: 1000, now: () => t })
    log.append("alice", { type: "status", i: 0 })
    t = 500
    log.append("alice", { type: "status", i: 1 })
    t = 1200
    expect(log.since("alice", "e.0")).toBeUndefined()
    expect(log.since("alice", "e.1")!.map((e) => e.message.i)).toEqual([1])
  })
})

/** Reads SSE frames with their ids and event names. */
function frames(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const all: Array<{ id?: string; event?: string; data?: any }> = []
  return {
    all,
    async next(predicate: (f: { id?: string; event?: string; data?: any }) => boolean = () => true, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        let index: number
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const frame: { id?: string; event?: string; data?: any } = {}
          for (const line of chunk.split("\n")) {
            if (line.startsWith("id: ")) frame.id = line.slice(4)
            else if (line.startsWith("event: ")) frame.event = line.slice(7)
            else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6))
          }
          if (frame.data === undefined && !frame.event) continue
          all.push(frame)
          if (predicate(frame)) return frame
        }
        const left = deadline - Date.now()
        if (left <= 0) throw new Error("timed out waiting for SSE frame")
        const result = await Promise.race([reader.read(), Bun.sleep(left).then(() => ({ timeout: true }) as const)])
        if ("timeout" in result) continue
        if (result.done) throw new Error("SSE stream ended")
        buffer += decoder.decode(result.value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const event = (type: string, data: Record<string, unknown>) => ({ t: "event" as const, event: { type, data } })
const isType = (type: string) => (f: { data?: any }) => f.data?.type === type

describe("/api/events: ids and replay", () => {
  test("every message carries an id; the first catalog carries the latest one", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const stream = frames(await h.api("/api/events"))
    const catalog = await stream.next(isType("catalog"))
    expect(catalog.id).toMatch(/^[a-z0-9]+\.\d+$/)
    client.send(event("session.execution.started", { sessionID: "ses_1" }))
    const status = await stream.next(isType("status"))
    expect(status.id).toBeDefined()
    expect(Number(status.id!.split(".")[1])).toBeGreaterThan(Number(catalog.id!.split(".")[1]))
    await stream.cancel()
  })

  test("reconnecting with Last-Event-ID replays what was missed instead of starting over", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const first = frames(await h.api("/api/events"))
    await first.next(isType("catalog"))
    client.send(event("session.execution.started", { sessionID: "ses_1" }))
    const seen = await first.next(isType("status"))
    await first.cancel()
    // Missed while disconnected:
    client.send(event("session.text.delta", { sessionID: "ses_1", assistantMessageID: "m1", delta: "Hello" }))
    client.send(event("session.execution.succeeded", { sessionID: "ses_1" }))
    await waitFor(() => h.registry.status("ses_1")?.[0]?.state === "idle")
    const again = frames(await h.api("/api/events", { headers: { "last-event-id": seen.id! } }))
    const delta = await again.next(isType("delta"))
    expect(delta.data.text).toBe("Hello")
    const status = await again.next(isType("status"))
    expect(status.data.sessions[0].state).toBe("idle")
    expect(again.all.some((f) => f.data?.type === "resync")).toBe(false)
    await again.cancel()
  })

  test("?last= works like Last-Event-ID (a new EventSource cannot set the header)", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const first = frames(await h.api("/api/events"))
    const catalog = await first.next(isType("catalog"))
    await first.cancel()
    client.send(event("session.execution.started", { sessionID: "ses_1" }))
    await waitFor(() => h.registry.status("ses_1")?.[0]?.state === "working")
    const again = frames(await h.api(`/api/events?last=${encodeURIComponent(catalog.id!)}`))
    expect((await again.next(isType("status"))).data.sessions[0].state).toBe("working")
    await again.cancel()
  })

  test("an id the hub cannot cover gets a fresh catalog and a resync marker", async () => {
    h = harness()
    await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const stream = frames(await h.api("/api/events", { headers: { "last-event-id": "oldepoch.42" } }))
    await stream.next(isType("catalog"))
    const resync = await stream.next(isType("resync"))
    expect(resync.id).toBeDefined()
    await stream.cancel()
  })

  test("heartbeats are named ping events (visible to the page) without an id", async () => {
    h = harness({ timing: { heartbeatMs: 30 } } as any)
    const stream = frames(await h.api("/api/events"))
    const ping = await stream.next((f) => f.event === "ping")
    expect(ping.id).toBeUndefined()
    await stream.cancel()
  })
})

describe("/api/events: lite and per-session streams", () => {
  test("?lite=1 leaves out streamed text and reasoning but keeps status and activity", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const lite = frames(await h.api("/api/events?lite=1"))
    await lite.next(isType("catalog"))
    client.send(event("session.text.delta", { sessionID: "ses_1", assistantMessageID: "m1", delta: "Hello" }))
    client.send(event("session.reasoning.delta", { sessionID: "ses_1", assistantMessageID: "m1", delta: "hmm" }))
    client.send(event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "m1", id: "t1", name: "bash" }))
    client.send(event("session.execution.started", { sessionID: "ses_1" }))
    await lite.next(isType("status"))
    expect(lite.all.some((f) => f.data?.type === "delta" || f.data?.type === "reasoning")).toBe(false)
    expect(lite.all.some((f) => f.data?.type === "activity")).toBe(true)
    await lite.cancel()
  })

  test("?lite=1&session=<id> still streams that session's tree, not others", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true }), session("ses_kid", { parentID: "ses_1" }), session("ses_2", { owned: true })] })
    const stream = frames(await h.api("/api/events?lite=1&session=ses_1"))
    await stream.next(isType("catalog"))
    client.send(event("session.text.delta", { sessionID: "ses_2", assistantMessageID: "m2", delta: "other" }))
    client.send(event("session.text.delta", { sessionID: "ses_kid", assistantMessageID: "m1", delta: "kid" }))
    const delta = await stream.next(isType("delta"))
    expect(delta.data.text).toBe("kid")
    expect(stream.all.some((f) => f.data?.text === "other")).toBe(false)
    await stream.cancel()
  })

  test("replay applies the same filter", async () => {
    h = harness()
    const client = await spoke(h, { sessions: [session("ses_1", { owned: true })] })
    const first = frames(await h.api("/api/events?lite=1"))
    const catalog = await first.next(isType("catalog"))
    await first.cancel()
    client.send(event("session.text.delta", { sessionID: "ses_1", assistantMessageID: "m1", delta: "Hello" }))
    client.send(event("session.execution.started", { sessionID: "ses_1" }))
    await waitFor(() => h.registry.status("ses_1")?.[0]?.state === "working")
    const again = frames(await h.api(`/api/events?lite=1&last=${encodeURIComponent(catalog.id!)}`))
    await again.next(isType("status"))
    expect(again.all.some((f) => f.data?.type === "delta")).toBe(false)
    await again.cancel()
  })
})
