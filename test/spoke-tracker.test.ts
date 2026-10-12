import { describe, expect, test } from "bun:test"
import { browserSessions, eventSessionID, isExposed, OWNED_WINDOW_MS, SessionTracker, shouldForward } from "../src/spoke/tracker"

const T0 = 1_700_000_000_000
const ev = (type: string, data: Record<string, unknown>, created?: number) => ({ type, data, ...(created ? { created } : {}) })
const created = (sessionID: string, extra: Record<string, unknown> = {}) =>
  ev("session.created", { sessionID, title: `title ${sessionID}`, location: { directory: "/work" }, slug: "s", ...extra })

describe("SessionTracker", () => {
  test("session.created records title, directory and parent, and owns the session", () => {
    const tracker = new SessionTracker()
    expect(tracker.observe(created("ses_a"), T0)).toBe(true)
    expect(tracker.observe(created("ses_b", { parentID: "ses_a", title: undefined }), T0)).toBe(true)
    expect(tracker.snapshot(T0)).toEqual([
      { id: "ses_a", title: "title ses_a", directory: "/work", updated: T0, owned: true },
      { id: "ses_b", title: "", directory: "/work", parentID: "ses_a", updated: T0, owned: true },
    ])
  })

  test("renamed updates the title; deleted removes the session", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    expect(tracker.observe(ev("session.renamed", { sessionID: "ses_a", title: "New" }), T0 + 1)).toBe(true)
    expect(tracker.snapshot(T0 + 1)[0]?.title).toBe("New")
    expect(tracker.observe(ev("session.deleted", { sessionID: "ses_a" }), T0 + 2)).toBe(true)
    expect(tracker.snapshot(T0 + 2)).toEqual([])
    expect(tracker.has("ses_a")).toBe(false)
  })

  test("activity events on an unknown session create an entry that needs info and is hidden until known", () => {
    const tracker = new SessionTracker()
    expect(tracker.observe(ev("session.execution.started", { sessionID: "ses_x" }), T0)).toBe(true)
    expect(tracker.needsInfo()).toEqual(["ses_x"])
    expect(tracker.snapshot(T0)).toEqual([])
    expect(tracker.setInfo("ses_x", { title: "X", directory: "/d", updated: T0 - 5 })).toBe(true)
    expect(tracker.needsInfo()).toEqual([])
    expect(tracker.snapshot(T0)).toEqual([{ id: "ses_x", title: "X", directory: "/d", updated: T0, owned: true }])
  })

  test("ownership lasts 30 minutes after the last activity", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    expect(tracker.snapshot(T0 + OWNED_WINDOW_MS)[0]?.owned).toBe(true)
    expect(tracker.snapshot(T0 + OWNED_WINDOW_MS + 1)[0]?.owned).toBe(false)
    for (const type of [
      "session.viewed",
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.inbox.delivered",
      "permission.asked",
    ]) {
      const t = T0 + 2 * OWNED_WINDOW_MS
      const fresh = new SessionTracker()
      fresh.observe(created("ses_a"), T0)
      fresh.observe(ev(type, { sessionID: "ses_a" }), t)
      expect(fresh.snapshot(t + 1000)[0]?.owned).toBe(true)
    }
  })

  test("uses the event timestamp for updated when present", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    tracker.observe(ev("session.renamed", { sessionID: "ses_a", title: "t" }, T0 + 42), T0 + 100)
    expect(tracker.snapshot(T0 + 100)[0]?.updated).toBe(T0 + 42)
  })

  test("events without a session ID and unrelated events change nothing", () => {
    const tracker = new SessionTracker()
    expect(tracker.observe(ev("session.text.delta", { sessionID: "ses_a", delta: "x" }), T0)).toBe(false)
    expect(tracker.observe(ev("server.connected", {}), T0)).toBe(false)
    expect(tracker.needsInfo()).toEqual([])
  })

  test("rootOf follows parents and survives cycles", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    tracker.observe(created("ses_b", { parentID: "ses_a" }), T0)
    tracker.observe(created("ses_c", { parentID: "ses_b" }), T0)
    expect(tracker.rootOf("ses_c")).toBe("ses_a")
    expect(tracker.rootOf("ses_unknown")).toBe("ses_unknown")
    tracker.setInfo("ses_a", { title: "", directory: "/w", parentID: "ses_c", updated: T0 })
    expect(typeof tracker.rootOf("ses_c")).toBe("string")
  })
})

describe("exposure", () => {
  const tracker = () => {
    const t = new SessionTracker()
    t.observe(created("ses_a"), T0)
    t.observe(created("ses_child", { parentID: "ses_a" }), T0)
    t.observe(created("ses_b"), T0)
    return t
  }

  test("off exposes nothing, always exposes everything", () => {
    const t = tracker()
    expect(isExposed({ mode: "off", sessions: ["ses_a"] }, t, "ses_a")).toBe(false)
    expect(isExposed({ mode: "always", sessions: [] }, t, "ses_zzz")).toBe(true)
  })

  test("session mode exposes listed sessions and their descendants only", () => {
    const t = tracker()
    const config = { mode: "session" as const, sessions: ["ses_a"] }
    expect(isExposed(config, t, "ses_child")).toBe(true)
    expect(isExposed(config, t, "ses_b")).toBe(false)
  })

  test("eventSessionID reads data.sessionID or data.form.sessionID", () => {
    expect(eventSessionID(ev("permission.asked", { sessionID: "ses_a", id: "per_1" }))).toBe("ses_a")
    expect(eventSessionID(ev("form.created", { form: { sessionID: "ses_f", id: "frm" } }))).toBe("ses_f")
    expect(eventSessionID(ev("server.connected", {}))).toBeUndefined()
  })

  test("shouldForward requires a forwarded type and an exposed session", () => {
    const t = tracker()
    const config = { mode: "session" as const, sessions: ["ses_a"] }
    expect(shouldForward(config, t, ev("session.execution.started", { sessionID: "ses_child" }))).toBe(true)
    expect(shouldForward(config, t, ev("session.execution.started", { sessionID: "ses_b" }))).toBe(false)
    expect(shouldForward(config, t, ev("session.inbox.enqueued", { sessionID: "ses_a", inboxID: "m" }))).toBe(false)
    expect(shouldForward({ mode: "off", sessions: [] }, t, ev("session.created", { sessionID: "ses_a" }))).toBe(false)
  })

  test("conversation-mode events are forwarded for exposed sessions only", () => {
    const t = tracker()
    const config = { mode: "session" as const, sessions: ["ses_a"] }
    for (const type of ["session.text.ended", "session.inbox.delivered", "session.agent.selected"]) {
      expect(shouldForward(config, t, ev(type, { sessionID: "ses_a" }))).toBe(true)
      expect(shouldForward(config, t, ev(type, { sessionID: "ses_b" }))).toBe(false)
    }
  })
})

describe("service listing", () => {
  const listed = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `L ${id}`,
    directory: "/u/voice/web",
    updated: T0 - 1000,
    project: "/u/voice",
    projectName: "voice",
    ...extra,
  })

  test("adds listed sessions with their workspace, not owned", () => {
    const tracker = new SessionTracker()
    expect(tracker.applyListing([listed("ses_l")], T0)).toBe(true)
    expect(tracker.snapshot(T0)).toEqual([
      { id: "ses_l", title: "L ses_l", directory: "/u/voice/web", updated: T0 - 1000, owned: false, project: "/u/voice", projectName: "voice" },
    ])
    expect(tracker.applyListing([listed("ses_l")], T0)).toBe(false)
  })

  test("keeps live title and directory but takes the workspace", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    tracker.applyListing([listed("ses_a", { title: "stale", directory: "/old" })], T0)
    expect(tracker.snapshot(T0)[0]).toEqual({
      id: "ses_a",
      title: "title ses_a",
      directory: "/work",
      updated: T0,
      owned: true,
      project: "/u/voice",
      projectName: "voice",
    })
  })

  test("refreshes sessions known only from the listing (renamed elsewhere)", () => {
    const tracker = new SessionTracker()
    tracker.applyListing([listed("ses_l")], T0)
    expect(tracker.applyListing([listed("ses_l", { title: "New name", updated: T0 - 5 })], T0)).toBe(true)
    expect(tracker.snapshot(T0)[0]).toMatchObject({ title: "New name", updated: T0 - 5 })
  })

  test("drops listed sessions that left the listing unless this process is using them", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_live"), T0)
    tracker.applyListing([listed("ses_gone"), listed("ses_live"), listed("ses_stay")], T0)
    expect(tracker.applyListing([listed("ses_stay")], T0)).toBe(true)
    expect(tracker.snapshot(T0).map((s) => s.id).sort()).toEqual(["ses_live", "ses_stay"])
    // Sessions never listed (live children, other directories) are not touched by the listing.
    tracker.observe(created("ses_kid", { parentID: "ses_live" }), T0)
    tracker.applyListing([], T0 + OWNED_WINDOW_MS + 1)
    expect(tracker.snapshot(T0 + OWNED_WINDOW_MS + 1).map((s) => s.id).sort()).toEqual(["ses_kid", "ses_live"])
  })
})

describe("browserSessions", () => {
  const tracker = () => {
    const t = new SessionTracker()
    t.observe(created("ses_a"), T0)
    t.observe(created("ses_child", { parentID: "ses_a" }), T0)
    t.observe(created("ses_b"), T0)
    t.observe(created("ses_b_kid", { parentID: "ses_b" }), T0)
    return t
  }

  test("off reports nothing; always reports everything as exposed", () => {
    expect(browserSessions({ mode: "off", sessions: [] }, tracker(), T0)).toEqual([])
    const all = browserSessions({ mode: "always", sessions: [] }, tracker(), T0)
    expect(all.map((s) => [s.id, s.exposed])).toEqual([
      ["ses_a", true],
      ["ses_child", true],
      ["ses_b", true],
      ["ses_b_kid", true],
    ])
  })

  test("session mode marks exposure and leaves out children of unexposed sessions", () => {
    const sessions = browserSessions({ mode: "session", sessions: ["ses_a"] }, tracker(), T0)
    expect(sessions.map((s) => [s.id, s.exposed])).toEqual([
      ["ses_a", true],
      ["ses_child", true],
      ["ses_b", false],
    ])
  })

  test("caps the count, keeping exposed and most recent sessions, in tracker order", () => {
    const t = new SessionTracker()
    t.applyListing(
      Array.from({ length: 10 }, (_, i) => ({ id: `ses_${i}`, title: "", directory: "/d", updated: T0 - i * 10 })),
      T0,
    )
    const sessions = browserSessions({ mode: "session", sessions: ["ses_9"] }, t, T0, { max: 4 })
    expect(sessions.map((s) => s.id)).toEqual(["ses_0", "ses_1", "ses_2", "ses_9"])
  })

  test("caps the frame size", () => {
    const t = new SessionTracker()
    t.applyListing(
      Array.from({ length: 20 }, (_, i) => ({ id: `ses_${i}`, title: "x".repeat(1000), directory: "/d", updated: T0 - i })),
      T0,
    )
    const sessions = browserSessions({ mode: "always", sessions: [] }, t, T0, { maxBytes: 5000 })
    expect(sessions.length).toBeGreaterThan(0)
    expect(JSON.stringify(sessions).length).toBeLessThanOrEqual(5000)
    expect(sessions.map((s) => s.id)).toEqual(sessions.map((_, i) => `ses_${i}`))
  })
})
