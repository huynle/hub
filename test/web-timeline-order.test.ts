// Console timeline ordering, end to end from OpenCode messages: the spoke's timeline rows (history pages) and the
// live events the console receives, in the order a real session produced them (fixture: a trimmed, anonymised
// copy of a session that spawned twelve background subagents over several turns).
import { describe, expect, test } from "bun:test"
import { newestPage, timelineItems, type TimelineItem } from "../src/spoke/timeline"
import { Timeline, type TimelineInput } from "../web/src/core/timeline-core"
import session from "./fixtures/timeline-subagents-session.json"

type Message = { id: string; type: string; time?: { created?: number }; content?: any[] }
const context = session as unknown as Message[]
const ROOT = "root"
const items = (messages: readonly Message[] = context) => timelineItems(ROOT, messages)
const all = items()
const children = all.filter((i) => i.childSessionID).map((i) => ({ id: i.childSessionID!, title: i.title! }))
/** The hub's status tree: the root and its subagents (finished ones are idle; no `since`). */
const tree = (state: Record<string, string> = {}, rootState = "idle") => [
  { id: ROOT, title: "Firmware rewrite", state: rootState },
  ...children.filter((c) => state[c.id] !== "absent").map((c) => ({ id: c.id, parentID: ROOT, title: c.title, state: state[c.id] ?? "idle" })),
]
/** Where every row should be: in session order, a subagent row in place of the tool call that spawned it. */
const expected = (rows: readonly TimelineItem[], known = new Set(children.map((c) => c.id))) =>
  rows.map((r) => (r.childSessionID && known.has(r.childSessionID) ? `sub:${r.childSessionID}` : r.key))
/** Spoke rows as the console receives them (JSON). */
const feed = (timeline: Timeline, rows: readonly TimelineItem[], options?: { older?: boolean }) => timeline.load(rows as unknown as TimelineInput[], options)
const keys = (timeline: Timeline) => timeline.rows().filter((r) => !r.depth).map((r) => r.key)

describe("Timeline ordering: history", () => {
  test("finished subagents sit where they were spawned, in place of the spawning tool row, not at the bottom", () => {
    const timeline = new Timeline()
    timeline.status(tree(), ROOT)
    feed(timeline, all)
    expect(keys(timeline)).toEqual(expected(all))
    const subs = timeline.rows().filter((r) => r.kind === "subagent")
    expect(subs.map((s) => s.label)).toEqual(children.map((c) => c.title))
    expect(subs.every((s) => s.state === "done")).toBe(true)
    // The first five follow the question that started them; the last row of the session is not a subagent.
    const order = keys(timeline)
    expect(order.indexOf("sub:ses_child01")).toBeGreaterThan(order.indexOf("msg_001:text"))
    expect(order.indexOf("sub:ses_child05")).toBeLessThan(order.indexOf("msg_004:0"))
    expect(order.at(-1)).toBe("msg_078:text")
  })

  test("reasoning stays before the text of the same message even though the text has an earlier time", () => {
    const timeline = new Timeline()
    feed(timeline, all)
    const order = keys(timeline)
    expect(order.indexOf("msg_002:0")).toBeLessThan(order.indexOf("msg_002:1"))
  })

  test("the status tree arriving after the history (or never) does not move anything", () => {
    const timeline = new Timeline()
    feed(timeline, all)
    timeline.status(tree(), ROOT)
    expect(keys(timeline)).toEqual(expected(all))
    // Without a status entry the spawning tool row stays a tool row in its place.
    const bare = new Timeline()
    feed(bare, all)
    expect(keys(bare)).toEqual(all.map((r) => r.key))
  })

  test("paged history: a subagent whose spawn is not loaded yet goes to the top, then moves to its spawn when the page arrives", () => {
    const timeline = new Timeline()
    timeline.status(tree(), ROOT)
    let page = newestPage(all, 40)
    feed(timeline, page.items)
    const loaded = new Set(page.items.map((i) => i.childSessionID).filter(Boolean))
    const pagedOut = children.filter((c) => !loaded.has(c.id)).map((c) => `sub:${c.id}`)
    expect(pagedOut.length).toBeGreaterThan(0)
    const order = keys(timeline)
    expect(order.slice(0, pagedOut.length)).toEqual(pagedOut)
    expect(order.slice(pagedOut.length)).toEqual(expected(page.items))
    while (page.older) {
      page = newestPage(all, 40, page.older)
      feed(timeline, page.items, { older: true })
    }
    expect(keys(timeline)).toEqual(expected(all))
  })

  test("a finished subagent with no spawning row is never placed by the time the page loaded", () => {
    const timeline = new Timeline()
    timeline.status([{ id: ROOT, state: "idle" }, { id: "ses_old", parentID: ROOT, title: "Old", state: "idle" }], ROOT)
    feed(timeline, all.slice(-10))
    expect(keys(timeline)[0]).toBe("sub:ses_old")
    // It stays there while new rows arrive.
    timeline.upsert({ key: "local:1", kind: "user", text: "next", at: Date.now() })
    expect(keys(timeline)[0]).toBe("sub:ses_old")
  })
})

/** Replays messages as the live events a console receives while they run. */
function replay(timeline: Timeline, messages: readonly Message[], spawned: Record<string, string>) {
  for (const message of messages) {
    if (message.type !== "assistant") continue
    let texts = 0
    for (const part of message.content ?? []) {
      if (part.type === "reasoning") timeline.appendReasoning({ sessionID: ROOT, messageID: message.id, delta: "thinking…" })
      if (part.type === "text") timeline.appendText({ sessionID: ROOT, messageID: message.id, ordinal: texts++, delta: part.text })
      if (part.type === "tool") {
        const child = part.state?.metadata?.sessionID as string | undefined
        timeline.activity(ROOT, { id: part.id, kind: "tool", tool: part.name, state: "running", at: Date.now() })
        if (child) {
          timeline.activity(ROOT, { id: part.id, kind: "tool", tool: part.name, state: "running", childSessionID: child, at: Date.now() })
          spawned[child] = "working"
          timeline.status(tree(spawned, "working"), ROOT)
        }
        timeline.activity(ROOT, { id: part.id, kind: "tool", tool: part.name, state: "done", ...(child ? { childSessionID: child } : {}), at: Date.now() })
      }
    }
  }
}

describe("Timeline ordering: errors and retries", () => {
  test("error and retry rows of a failed turn keep their history position", () => {
    const timeline = new Timeline()
    timeline.load([
      { key: "m2:error", kind: "error", messageID: "m2", text: "quota", errorType: "provider.quota", pos: 30 },
      { key: "u1", kind: "user", text: "go", pos: 10 },
      { key: "m2:retry:1", kind: "retry", messageID: "m2", text: "Rate limited", attempt: 1, next: 5, pos: 20 },
    ])
    expect(timeline.rows().map((r) => [r.key, r.kind])).toEqual([
      ["u1", "user"],
      ["m2:retry:1", "retry"],
      ["m2:error", "error"],
    ])
    expect(timeline.rows()[1]).toMatchObject({ attempt: 1, next: 5 })
  })
})

describe("Timeline ordering: live events", () => {
  // History up to the turn that spawns S3 and S6 (msg_046: reasoning, text, shell; msg_047: two subagents;
  // msg_048: text), which then runs live.
  const before = context.slice(0, 45)
  const live = context.slice(45, 48)
  const after = context.slice(0, 48)
  const start = () => {
    const spawned: Record<string, string> = Object.fromEntries(children.map((c) => [c.id, "absent"]))
    for (const row of items(before)) if (row.childSessionID) spawned[row.childSessionID] = "idle"
    const timeline = new Timeline()
    timeline.status(tree(spawned), ROOT)
    feed(timeline, newestPage(items(before), 80).items)
    return { timeline, spawned }
  }

  test("live thoughts, text, tools and spawned subagents appear in arrival order after the history, and stay put", () => {
    const { timeline, spawned } = start()
    const history = keys(timeline)
    replay(timeline, live, spawned)
    const liveKeys = ["msg_046:reasoning", "msg_046:text:0", expect.stringMatching(/^activity:root:/), "sub:ses_child09", "sub:ses_child10", "msg_048:text:0"]
    expect(keys(timeline)).toEqual([...history, ...liveKeys])
    // The subagents finish much later; more text arrives; nothing moves.
    spawned.ses_child09 = "idle"
    spawned.ses_child10 = "idle"
    timeline.status(tree(spawned), ROOT)
    timeline.appendText({ sessionID: ROOT, messageID: "msg_late", ordinal: 0, delta: "Both done." })
    expect(keys(timeline)).toEqual([...history, ...liveKeys, "msg_late:text:0"])
  })

  test("the history of the live rows replaces them in place (resync), and a reload shows the same order", () => {
    const { timeline, spawned } = start()
    replay(timeline, live, spawned)
    timeline.appendText({ sessionID: ROOT, messageID: "msg_next", ordinal: 0, delta: "Still streaming" })
    const page = newestPage(items(after), 80).items
    feed(timeline, page)
    const known = new Set(Object.entries(spawned).filter(([, s]) => s !== "absent").map(([id]) => id))
    const loaded = new Set([...newestPage(items(before), 80).items, ...page].map((r) => r.key))
    // Every stored part replaced its live row in place; the still-streaming text stays last.
    expect(keys(timeline)).toEqual([...expected(items(after).filter((r) => loaded.has(r.key)), known), "msg_next:text:0"])
    // A page reload: the finished subagents come from the status tree, the order from the history.
    spawned.ses_child09 = "idle"
    spawned.ses_child10 = "idle"
    const reloaded = new Timeline()
    reloaded.status(tree(spawned), ROOT)
    feed(reloaded, page)
    expect(keys(reloaded)).toEqual(expected(page, known))
    expect(keys(reloaded).slice(-expected(items(live)).length)).toEqual(expected(items(live), known))
  })

  test("a subagent seen live without its spawn row stays where it first appeared after it finishes", () => {
    const timeline = new Timeline()
    timeline.status([{ id: ROOT, state: "idle" }], ROOT)
    feed(timeline, all.slice(-5))
    timeline.appendText({ sessionID: ROOT, messageID: "m1", delta: "Starting a helper." })
    timeline.status([{ id: ROOT, state: "working" }, { id: "ses_new", parentID: ROOT, title: "Helper", state: "working" }], ROOT)
    timeline.appendText({ sessionID: ROOT, messageID: "m2", delta: "Meanwhile…" })
    timeline.status([{ id: ROOT, state: "idle" }, { id: "ses_new", parentID: ROOT, title: "Helper", state: "idle" }], ROOT)
    expect(keys(timeline).slice(-3)).toEqual(["m1:text", "sub:ses_new", "m2:text"])
  })

  test("a sent message is replaced by its stored copy instead of showing twice", () => {
    const timeline = new Timeline()
    feed(timeline, [])
    timeline.upsert({ key: "local:1", kind: "user", text: "did the rest of the feature complete?", at: Date.now() })
    feed(timeline, all.slice(0, 3))
    expect(keys(timeline).filter((k) => k === "local:1" || k === "msg_001:text")).toEqual(["msg_001:text"])
  })

  test("spoken text joins the latest streamed text part of its message", () => {
    const timeline = new Timeline()
    expect(timeline.liveTextKey("m1")).toBe("m1:text")
    timeline.appendText({ sessionID: ROOT, messageID: "m1", ordinal: 0, delta: "First." })
    timeline.appendText({ sessionID: ROOT, messageID: "m1", ordinal: 1, delta: "Second." })
    expect(timeline.liveTextKey("m1")).toBe("m1:text:1")
  })

  test("a stored tool row keeps the live row's short summary", () => {
    const timeline = new Timeline()
    timeline.activity(ROOT, { id: "call_1", tool: "shell", summary: "bun test", state: "done", at: 1 })
    feed(timeline, [{ key: "m1:0", messageID: "m1", partID: "0", sessionID: ROOT, kind: "tool", name: "shell", state: "done", callID: "call_1", pos: 5 }])
    expect(timeline.rows().map((r) => [r.key, r.summary])).toEqual([["m1:0", "bun test"]])
  })
})
