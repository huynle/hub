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

  test("shouldForward requires a forwarded type and a known session, not Voice exposure", () => {
    const t = tracker()
    const config = { mode: "session" as const, sessions: ["ses_a"] }
    expect(shouldForward(config, t, ev("session.execution.started", { sessionID: "ses_child" }))).toBe(true)
    expect(shouldForward(config, t, ev("session.execution.started", { sessionID: "ses_b" }))).toBe(true)
    expect(shouldForward(config, t, ev("session.execution.started", { sessionID: "ses_unknown" }))).toBe(false)
    expect(shouldForward(config, t, ev("session.inbox.enqueued", { sessionID: "ses_a", inboxID: "m" }))).toBe(false)
    expect(shouldForward({ mode: "off", sessions: [] }, t, ev("session.created", { sessionID: "ses_a" }))).toBe(false)
  })

  test("timeline events are forwarded for known sessions whether or not Voice is on", () => {
    const t = tracker()
    const config = { mode: "session" as const, sessions: ["ses_a"] }
    for (const type of ["session.text.ended", "session.inbox.delivered", "session.agent.selected"]) {
      expect(shouldForward(config, t, ev(type, { sessionID: "ses_a" }))).toBe(true)
      expect(shouldForward(config, t, ev(type, { sessionID: "ses_b" }))).toBe(true)
      expect(shouldForward({ mode: "off", sessions: [] }, t, ev(type, { sessionID: "ses_a" }))).toBe(false)
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

  test("session mode marks Voice exposure and keeps children of unexposed sessions for inspection", () => {
    const sessions = browserSessions({ mode: "session", sessions: ["ses_a"] }, tracker(), T0)
    expect(sessions.map((s) => [s.id, s.exposed])).toEqual([
      ["ses_a", true],
      ["ses_child", true],
      ["ses_b", false],
      ["ses_b_kid", false],
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

describe("0.4 session view", () => {
  const listed = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `L ${id}`, directory: "/d", updated: T0 - 1000, ...extra })

  test("the listing never drops sessions in the keep set", () => {
    const tracker = new SessionTracker()
    tracker.applyListing([listed("ses_open"), listed("ses_gone")], T0)
    expect(tracker.applyListing([], T0, new Set(["ses_open"]))).toBe(true)
    expect(tracker.snapshot(T0).map((s) => s.id)).toEqual(["ses_open"])
  })

  test("active: sessions running or waiting on a permission or form, by root", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    tracker.observe(created("ses_kid", { parentID: "ses_a" }), T0)
    tracker.observe(created("ses_b"), T0)
    tracker.observe(created("ses_c"), T0)
    expect(tracker.active()).toEqual([])
    tracker.observe(ev("session.execution.started", { sessionID: "ses_kid" }), T0)
    tracker.observe(ev("permission.asked", { sessionID: "ses_b", id: "per_1" }), T0)
    tracker.observe(ev("form.created", { form: { id: "frm_1", sessionID: "ses_c" } }), T0)
    expect(tracker.active().sort()).toEqual(["ses_a", "ses_b", "ses_c"])
    tracker.observe(ev("session.execution.succeeded", { sessionID: "ses_kid" }), T0)
    tracker.observe(ev("permission.replied", { sessionID: "ses_b", requestID: "per_1" }), T0)
    tracker.observe(ev("form.cancelled", { form: { id: "frm_1", sessionID: "ses_c" } }), T0)
    expect(tracker.active()).toEqual([])
    tracker.observe(ev("session.execution.started", { sessionID: "ses_b" }), T0)
    tracker.observe(ev("session.deleted", { sessionID: "ses_b" }), T0)
    expect(tracker.active()).toEqual([])
  })

  test("ensure adds an unknown session that needs info, without owning it", () => {
    const tracker = new SessionTracker()
    expect(tracker.ensure("ses_x", T0)).toBe(true)
    expect(tracker.ensure("ses_x", T0)).toBe(false)
    expect(tracker.needsInfo()).toEqual(["ses_x"])
    tracker.setInfo("ses_x", { title: "X", directory: "/d", updated: 5 })
    expect(tracker.snapshot(T0)).toEqual([{ id: "ses_x", title: "X", directory: "/d", updated: 5, owned: false }])
  })

  test("browserSessions marks open sessions with their terminal and keeps them first when capping", () => {
    const t = new SessionTracker()
    t.applyListing(
      Array.from({ length: 6 }, (_, i) => ({ id: `ses_${i}`, title: "", directory: "/d", updated: T0 - i * 10 })),
      T0,
    )
    const terminal = (id: string) => (id === "ses_5" ? { source: "herdr" as const, workspaceID: "w1", workspace: "app", status: "idle" as const } : undefined)
    const all = browserSessions({ mode: "always", sessions: [] }, t, T0, { terminal })
    expect(all.find((s) => s.id === "ses_5")).toMatchObject({ open: true, terminal: { source: "herdr", workspaceID: "w1" } })
    expect(all.find((s) => s.id === "ses_0")).not.toHaveProperty("open")
    expect(browserSessions({ mode: "always", sessions: [] }, t, T0, { max: 2, terminal }).map((s) => s.id)).toEqual(["ses_0", "ses_5"])
  })
})

describe("running detection: session status, shells and ptys", () => {
  const info = (id: string, sessionID: string, status = "running") => ({ id, status, command: "sleep 60", cwd: "/w", shell: "bash", file: "/tmp/x", metadata: { sessionID, background: true }, time: { started: T0 } })

  test("a busy or retrying session.status counts as active until idle", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    tracker.observe(ev("session.status", { sessionID: "ses_a", status: { type: "busy" } }), T0)
    expect(tracker.active()).toEqual(["ses_a"])
    tracker.observe(ev("session.status", { sessionID: "ses_a", status: { type: "retry", attempt: 1, message: "x", next: 1 } }), T0)
    expect(tracker.active()).toEqual(["ses_a"])
    tracker.observe(ev("session.status", { sessionID: "ses_a", status: { type: "idle" } }), T0)
    expect(tracker.active()).toEqual([])
  })

  test("a running shell of a subagent keeps its root active; shell.exited (no sessionID) ends it", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    tracker.observe(created("ses_kid", { parentID: "ses_a" }), T0)
    tracker.observe(ev("shell.created", { info: info("sh_1", "ses_kid") }), T0)
    expect(tracker.active()).toEqual(["ses_a"])
    expect(tracker.jobSession("sh_1")).toBe("ses_kid")
    tracker.observe(ev("shell.exited", { id: "sh_1", status: "exited", exit: 0 }), T0)
    expect(tracker.active()).toEqual([])
  })

  test("session.shell.started/ended and persistent ptys are tracked by session", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    tracker.observe(ev("session.shell.started", { sessionID: "ses_a", shell: info("sh_2", "ses_a") }), T0)
    expect(tracker.active()).toEqual(["ses_a"])
    tracker.observe(ev("session.shell.ended", { sessionID: "ses_a", shell: { ...info("sh_2", "ses_a"), status: "exited", exit: 0 }, output: { output: "" } }), T0)
    expect(tracker.active()).toEqual([])
    tracker.observe(ev("pty.created", { info: { id: "pty_1", title: "t", command: "htop", args: [], cwd: "/", status: "running", pid: 1, sessionID: "ses_a" } }), T0)
    expect(tracker.active()).toEqual(["ses_a"])
    tracker.observe(ev("pty.exited", { id: "pty_1", exitCode: 0 }), T0)
    expect(tracker.active()).toEqual([])
  })

  test("seed replaces a session's status and running jobs (snapshot at startup)", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    tracker.observe(ev("shell.created", { info: info("sh_old", "ses_a") }), T0)
    tracker.seed("ses_a", { status: "idle", jobs: [] })
    expect(tracker.active()).toEqual([])
    tracker.seed("ses_a", { status: "busy", jobs: [{ id: "sh_9", kind: "shell", command: "make", status: "running" }] })
    expect(tracker.active()).toEqual(["ses_a"])
    expect(tracker.jobSession("sh_9")).toBe("ses_a")
  })

  test("job events are forwarded once a session is resolved", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    const config = { mode: "always" as const, sessions: [] }
    for (const type of ["session.status", "shell.created", "shell.exited", "shell.deleted", "session.shell.started", "session.shell.ended", "pty.created", "pty.updated", "pty.exited", "pty.deleted", "session.seed"]) {
      expect(shouldForward(config, tracker, ev(type, { sessionID: "ses_a" }))).toBe(true)
    }
  })
})

describe("running detection: run end", () => {
  test("execution end clears a seeded busy status", () => {
    const tracker = new SessionTracker()
    tracker.observe(created("ses_a"), T0)
    tracker.seed("ses_a", { status: "busy", jobs: [] })
    tracker.observe(ev("session.execution.interrupted", { sessionID: "ses_a" }), T0)
    expect(tracker.active()).toEqual([])
  })
})
