// The console's hub state reducers (web/src/lib/store.ts): what each SSE message does to the shared state.
import { describe, expect, test } from "bun:test"
import { LiveFeeds, applyMessage, findSession, initialHub, isUnread, treeRunning } from "../web/src/lib/store"

const catalog = (sessions: Array<Record<string, unknown>>) => ({
  type: "catalog",
  machines: [{ id: "m1", name: "laptop", online: true, processes: [{ id: "p1", kind: "service", directory: "/", pid: 1, sessions }] }],
})

describe("applyMessage", () => {
  test("catalog replaces the machines; status patches the root session's tree in every process", () => {
    const s = initialHub()
    expect(applyMessage(s, catalog([{ id: "a", directory: "/x" }]))).toBe(true)
    expect(s.machines?.[0]?.name).toBe("laptop")
    applyMessage(s, { type: "status", sessionID: "a", sessions: [{ id: "a", state: "working" }] })
    expect(findSession(s.machines, "a")?.session.status).toEqual([{ id: "a", state: "working" }])
    expect(findSession(s.machines, "a")?.machine.id).toBe("m1")
  })

  test("conversation flips the session flag; reads replace the read marks", () => {
    const s = initialHub()
    applyMessage(s, catalog([{ id: "a", directory: "/x" }]))
    applyMessage(s, { type: "conversation", sessionID: "a", on: true })
    expect(findSession(s.machines, "a")?.session.conversation).toBe(true)
    applyMessage(s, { type: "reads", reads: { a: 5 } })
    expect(s.reads).toEqual({ a: 5 })
  })

  test("prefs from another device apply, unless a save is in flight (then they are marked stale)", () => {
    const s = initialHub()
    s.prefsSource = "hub"
    applyMessage(s, { type: "prefs", prefs: { pinnedSessions: ["a"] } })
    expect(s.prefs.pinnedSessions).toEqual(["a"])
    s.prefsPending = 1
    applyMessage(s, { type: "prefs", prefs: { pinnedSessions: ["b"] } })
    expect(s.prefs.pinnedSessions).toEqual(["a"])
    expect(s.prefsStale).toBe(true)
  })

  test("enrollment bumps a revision; handoff leaves a notice; junk changes nothing", () => {
    const s = initialHub()
    applyMessage(s, { type: "enrollment" })
    expect(s.enrollmentRev).toBe(1)
    applyMessage(s, { type: "handoff", sessionID: "a" })
    expect(s.notice).toMatchObject({ kind: "handoff", sessionID: "a" })
    expect(applyMessage(s, { type: "nonsense" })).toBe(false)
    expect(applyMessage(s, null)).toBe(false)
    expect(applyMessage(s, { type: "status", sessionID: 5 })).toBe(false)
  })
})

describe("helpers", () => {
  test("isUnread only for sessions read before their last update", () => {
    expect(isUnread("a", 10, { a: 5 })).toBe(true)
    expect(isUnread("a", 5, { a: 5 })).toBe(false)
    expect(isUnread("b", 10, { a: 5 })).toBe(false)
  })

  test("treeRunning while any session of the tree works or waits", () => {
    expect(treeRunning([{ id: "a", state: "idle" }, { id: "k", state: "working" }])).toBe(true)
    expect(treeRunning([{ id: "a", state: "blocked" }])).toBe(true)
    expect(treeRunning([{ id: "a", state: "idle" }])).toBe(false)
    expect(treeRunning(undefined)).toBe(false)
  })
})

describe("LiveFeeds", () => {
  test("routes activity, streams and status to the root's feed and reports the root", () => {
    const live = new LiveFeeds()
    expect(live.apply({ type: "activity", sessionID: "a", rootID: "a", item: { id: "t1", kind: "tool", tool: "bash", state: "running", at: 1 } })).toBe("a")
    expect(live.feed("a").now()).toBe("bash")
    expect(live.apply({ type: "delta", sessionID: "kid", rootID: "a", messageID: "m", text: "line one" })).toBe("a")
    expect(live.feed("a").rows().some((r) => r.kind === "subagent" && r.line === "line one")).toBe(true)
    expect(live.apply({ type: "status", sessionID: "a", sessions: [{ id: "a", state: "idle" }] })).toBe("a")
    expect(live.feed("a").pulse().busy).toBe(false)
    expect(live.apply({ type: "catalog" })).toBeUndefined()
  })

  test("keeps at most `max` feeds, dropping the oldest", () => {
    const live = new LiveFeeds(2)
    live.feed("a")
    live.feed("b")
    live.feed("c")
    expect(live.has("a")).toBe(false)
    expect(live.has("c")).toBe(true)
  })
})
