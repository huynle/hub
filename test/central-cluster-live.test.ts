// The cluster live fan-out (design §9, decision vkxkqiuf §6): a user's console events go over the Bus
// (user.<id>.live) to every pod; all but streamed text (delta, reasoning) are appended to the shared EventLog first,
// so their ids resume on any pod.
import { describe, expect, test } from "bun:test"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { MemoryEventLog } from "../src/central/backend/memory-events"
import { LiveFanout, liveTopic, type LiveEvent } from "../src/central/cluster/live"

function pods() {
  const bus = new MemoryBus()
  const events = new MemoryEventLog()
  const a = new LiveFanout({ bus, events, podID: "pod-a" })
  const b = new LiveFanout({ bus, events, podID: "pod-b" })
  return { bus, events, a, b }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

describe("LiveFanout", () => {
  test("the topic is per user", () => {
    expect(liveTopic("u1")).toBe("user.u1.live")
  })

  test("an event sent on A reaches B's subscriber with an id the shared log resumes from", async () => {
    const { events, a, b } = pods()
    const seen: LiveEvent[] = []
    const sub = b.subscribe("u1", (event) => seen.push(event))
    await sub.ready
    const before = await events.latest("u1")
    await a.send("u1", { type: "status", sessionID: "ses_1" })
    await until(() => seen.length === 1)
    expect(seen[0]).toMatchObject({ message: { type: "status", sessionID: "ses_1" } })
    expect(seen[0]!.id).toBeDefined()
    const since = await events.since("u1", before)
    expect("events" in since && since.events.map((e) => e.id)).toEqual([seen[0]!.id!])
    sub.close()
  })

  test("streamed text (delta, reasoning) is broadcast only: no id, not in the log", async () => {
    const { events, a, b } = pods()
    const seen: LiveEvent[] = []
    const sub = b.subscribe("u1", (event) => seen.push(event))
    await sub.ready
    const before = await events.latest("u1")
    await a.send("u1", { type: "delta", sessionID: "ses_1", rootID: "ses_1", text: "Hel" })
    await a.send("u1", { type: "reasoning", sessionID: "ses_1", rootID: "ses_1", delta: "hmm" })
    await until(() => seen.length === 2)
    expect(seen.map((e) => e.id)).toEqual([undefined, undefined])
    expect(await events.since("u1", before)).toEqual({ events: [] })
    sub.close()
  })

  test("a user's events arrive in the order they were sent, on the sending pod too", async () => {
    const { a, b } = pods()
    const onA: string[] = []
    const onB: string[] = []
    const subA = a.subscribe("u1", (event) => onA.push(String(event.message.n)))
    const subB = b.subscribe("u1", (event) => onB.push(String(event.message.n)))
    await Promise.all([subA.ready, subB.ready])
    void a.send("u1", { type: "status", n: 1 })
    void a.send("u1", { type: "delta", n: 2 })
    void a.send("u1", { type: "turn", n: 3 })
    await until(() => onA.length === 3 && onB.length === 3)
    expect(onA).toEqual(["1", "2", "3"])
    expect(onB).toEqual(["1", "2", "3"])
    subA.close()
    subB.close()
  })

  test("users are isolated: a subscriber of one user never gets another's events", async () => {
    const { a, b } = pods()
    const seen: LiveEvent[] = []
    const sub = b.subscribe("u2", (event) => seen.push(event))
    await sub.ready
    await a.send("u1", { type: "status", secret: true })
    await a.send("u2", { type: "status", mine: true })
    await until(() => seen.length === 1)
    expect(JSON.stringify(seen)).not.toContain("secret")
    sub.close()
  })

  test("exceptDevice travels with the event", async () => {
    const { a, b } = pods()
    const seen: LiveEvent[] = []
    const sub = b.subscribe("u1", (event) => seen.push(event))
    await sub.ready
    await a.send("u1", { type: "prefs" }, "dev_1")
    await until(() => seen.length === 1)
    expect(seen[0]!.exceptDevice).toBe("dev_1")
    sub.close()
  })

  test("closing one subscription keeps the others of the same user", async () => {
    const { bus, a, b } = pods()
    const first: LiveEvent[] = []
    const second: LiveEvent[] = []
    const one = b.subscribe("u1", (event) => first.push(event))
    const two = b.subscribe("u1", (event) => second.push(event))
    await Promise.all([one.ready, two.ready])
    one.close()
    await a.send("u1", { type: "status" })
    await until(() => second.length === 1)
    expect(first).toEqual([])
    two.close()
    // The last one gone: B no longer listens on the topic.
    await Bun.sleep(5)
    expect(await bus.publish(liveTopic("u1"), { pod: "x", message: { type: "status" } })).toBe(0)
  })

  test("a catalog change is announced to every pod (never logged)", async () => {
    const { a, b } = pods()
    await Promise.all([a.start(), b.start()])
    let onA = 0
    let onB = 0
    a.onCatalog(() => onA++)
    b.onCatalog(() => onB++)
    await a.publishCatalog()
    await until(() => onA === 1 && onB === 1)
    await Promise.all([a.stop(), b.stop()])
  })
})
