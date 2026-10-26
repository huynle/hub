// HarnessSpoke: the base of a non-OpenCode spoke. Announces the ops it has handlers for, refuses the others with a
// clear error (a hub that predates announced core ops sends them anyway), reports its sessions, and sends only
// valid harness events (the T1 subset).
import { afterEach, describe, expect, test } from "bun:test"
import type { ServerRequest, SessionInfo } from "../../protocol/src/index.ts"
import { HarnessSpoke, hubSessionID, type HarnessSpokeOptions } from "../src/index.ts"
import { call, fakeSockets } from "./fake-socket.ts"

const S1 = hubSessionID("cc", "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f")
const S2 = hubSessionID("cc", "0a1b2c3d-4d5a-4b6c-9e7f-3f2b8c1e4d5e")
const info = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: "t", directory: "/w", updated: 1, owned: true, ...extra })

const spokes: HarnessSpoke[] = []
afterEach(() => {
  for (const s of spokes.splice(0)) s.stop()
})

function make(options: Partial<HarnessSpokeOptions> = {}) {
  const sockets = fakeSockets()
  const spoke = new HarnessSpoke({
    server: "https://hub.example",
    token: "hmt1.MACHINE-SECRET",
    harness: "claude-code",
    harnessVersion: "2.1.296",
    evidence: "hooks",
    pluginVersion: "0.6.1",
    directory: "/w",
    socket: sockets.factory,
    ...options,
  })
  spokes.push(spoke)
  return { spoke, sockets }
}

async function connected(options: Partial<HarnessSpokeOptions> = {}) {
  const made = make(options)
  made.spoke.start()
  made.sockets.last.open()
  made.sockets.last.welcome()
  return { ...made, socket: made.sockets.last }
}

describe("hello", () => {
  test("announces the core ops and features it has handlers for, with harness and evidence", async () => {
    const { socket } = await connected({ handlers: { permission: async () => ({}), stop: async () => ({ stopped: [] }), rename: async (r) => ({ title: r.title }) } })
    const hello = socket.frames.find((f) => f.t === "hello")
    expect(hello).toBeDefined()
    if (hello?.t !== "hello") throw new Error("no hello")
    expect(hello.harness).toBe("claude-code")
    expect(hello.evidence).toBe("hooks")
    expect(hello.features).toEqual(["stop", "permission", "rename", "sessionTokens", "actTokens"])
    expect(socket.headers.Authorization).toBe("Bearer hmt1.MACHINE-SECRET")
    expect(socket.url).toBe("wss://hub.example/spoke/ws")
  })

  test("setModelPrefs is served with modelPrefs; a modifier feature needs its op", () => {
    const { spoke } = make({ handlers: { modelPrefs: async () => ({ prefs: {}, defaults: {} }), setModelPrefs: async () => ({ prefs: {}, defaults: {} }) } })
    expect(spoke.features).toContain("modelPrefs")
    expect(() => make({ features: ["permissionMessage"] })).toThrow(/permission/)
    expect(() => make({ features: ["launch"] })).toThrow(/create/)
    expect(make({ handlers: { permission: async () => ({}) }, features: ["permissionMessage"] }).spoke.features).toContain("permissionMessage")
  })

  test("turnEvents (confirmed turn ends, rpc evidence trusted for idle) is announced without needing an op", async () => {
    const { socket } = await connected({ evidence: "rpc", handlers: { turn: async () => ({ outcome: "succeeded", reply: "" }) }, features: ["turnEvents"] })
    const hello = socket.frames.find((f) => f.t === "hello")
    if (hello?.t !== "hello") throw new Error("no hello")
    expect(hello.features).toEqual(["turn", "sessionTokens", "actTokens", "turnEvents"])
    expect(make({ features: ["turnEvents"] }).spoke.features).toContain("turnEvents")
  })

  test("a handler for an op that only modelPrefs serves is not enough on its own", () => {
    expect(() => make({ handlers: { setModelPrefs: async () => ({ prefs: {}, defaults: {} }) } })).toThrow(/modelPrefs/)
  })
})

describe("op dispatch", () => {
  test("runs the op's handler for a reported session and answers its result", async () => {
    const seen: ServerRequest[] = []
    const { spoke, socket } = await connected({
      handlers: {
        permission: async (req) => {
          seen.push(req)
          return { gone: true }
        },
      },
    })
    spoke.upsertSession(info(S1))
    const res = await call(socket, { op: "permission", sessionID: S1, requestID: "per_1", decision: "once" })
    expect(res).toMatchObject({ ok: true, result: { gone: true } })
    expect(seen).toHaveLength(1)
  })

  test("refuses an op it did not announce, naming the op and the harness", async () => {
    const { spoke, socket } = await connected({ handlers: { permission: async () => ({}) } })
    spoke.upsertSession(info(S1))
    for (const req of [
      { op: "turn", sessionID: S1, text: "hi", voiceStyle: false },
      { op: "steer", sessionID: S1, text: "hi" },
      { op: "interrupt", sessionID: S1 },
      { op: "timeline", sessionID: S1 },
    ] as ServerRequest[]) {
      const res = await call(socket, req)
      expect(res.ok).toBe(false)
      expect(res.error).toContain(`"${req.op}"`)
      expect(res.error).toContain("claude-code")
      expect(res.error).toMatch(/not announced/)
    }
  })

  test("refuses an option feature it did not announce (permission message)", async () => {
    const { spoke, socket } = await connected({ handlers: { permission: async () => ({}) } })
    spoke.upsertSession(info(S1))
    const res = await call(socket, { op: "permission", sessionID: S1, requestID: "per_1", decision: "reject", message: "no" })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('"permissionMessage"')
  })

  test("refuses an op for a session it does not report", async () => {
    const { socket } = await connected({ handlers: { stop: async () => ({ stopped: [] }) } })
    const res = await call(socket, { op: "stop", sessionID: S2 })
    expect(res.ok).toBe(false)
    expect(res.error).toContain(S2)
  })

  test("a handler's error becomes the answer's error", async () => {
    const { spoke, socket } = await connected({
      handlers: {
        stop: async () => {
          throw new Error("cannot stop a TUI session")
        },
      },
    })
    spoke.upsertSession(info(S1))
    expect(await call(socket, { op: "stop", sessionID: S1 })).toMatchObject({ ok: false, error: "cannot stop a TUI session" })
  })

  test("dispatch can be called directly (no socket)", async () => {
    const { spoke } = make({ handlers: { stop: async () => ({ stopped: [S1] }) } })
    spoke.upsertSession(info(S1))
    expect(await spoke.dispatch({ op: "stop", sessionID: S1 })).toEqual({ stopped: [S1] })
    await expect(spoke.dispatch({ op: "interrupt", sessionID: S1 })).rejects.toThrow(/not announced/)
  })
})

describe("sessions", () => {
  test("sends a sessions frame on change and again after every welcome", async () => {
    const { spoke, sockets, socket } = await connected()
    spoke.upsertSession(info(S1))
    spoke.upsertSession(info(S2, { title: "two" }))
    const lists = () => sockets.last.frames.filter((f) => f.t === "sessions").map((f) => (f.t === "sessions" ? f.sessions.map((s) => s.id) : []))
    expect(lists().at(-1)).toEqual([S1, S2])
    spoke.endSession(S1)
    expect(lists().at(-1)).toEqual([S2])
    expect(spoke.sessions().map((s) => s.id)).toEqual([S2])
    // Reconnect: the new socket gets the list after its welcome.
    socket.onclose?.({ code: 1006 })
    spoke.retryNow()
    sockets.last.open()
    expect(lists()).toEqual([])
    sockets.last.welcome()
    expect(lists()).toEqual([[S2]])
  })

  test("refuses a session that is not a hub session ID (map native IDs first)", () => {
    const { spoke } = make()
    expect(() => spoke.upsertSession(info("3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f"))).toThrow(/hub session ID/)
    expect(() => spoke.upsertSession(info(S1, { parentID: "nope" }))).toThrow(/parentID/)
  })

  test("liveness: a session not touched within livenessMs is dropped by prune", async () => {
    let now = 1000
    const { spoke, sockets } = await connected({ livenessMs: 500, now: () => now })
    spoke.upsertSession(info(S1))
    spoke.upsertSession(info(S2))
    now = 1400
    spoke.touch(S2)
    now = 1600
    expect(spoke.prune()).toEqual([S1])
    expect(spoke.sessions().map((s) => s.id)).toEqual([S2])
    const last = sockets.last.frames.filter((f) => f.t === "sessions").at(-1)
    expect(last?.t === "sessions" && last.sessions.map((s) => s.id)).toEqual([S2])
    expect(spoke.prune()).toEqual([])
  })

  test("no liveness limit by default", () => {
    let now = 0
    const { spoke } = make({ now: () => now })
    spoke.upsertSession(info(S1))
    now = 10 ** 12
    expect(spoke.prune()).toEqual([])
  })

  test("an emitted event for a session keeps it alive", async () => {
    let now = 0
    const { spoke } = await connected({ livenessMs: 100, now: () => now })
    spoke.upsertSession(info(S1))
    now = 90
    spoke.emit({ type: "session.status", data: { sessionID: S1, status: { type: "busy" } } })
    now = 150
    expect(spoke.prune()).toEqual([])
  })
})

describe("emit", () => {
  test("sends a valid harness event and reports whether it was sent", async () => {
    const { spoke, socket } = await connected()
    spoke.upsertSession(info(S1))
    expect(spoke.emit({ type: "session.execution.started", data: { sessionID: S1 } })).toBe(true)
    const events = socket.frames.filter((f) => f.t === "event")
    expect(events.at(-1)).toEqual({ t: "event", event: { type: "session.execution.started", data: { sessionID: S1 } } })
  })

  test("refuses an event outside the harness subset or with bad data, with the protocol's reason", async () => {
    const { spoke, socket } = await connected()
    expect(() => spoke.emit({ type: "session.next.step.started", data: { sessionID: S1 } } as never)).toThrow(/event type must be one of/)
    expect(() => spoke.emit({ type: "session.status", data: { sessionID: "3f2b", status: { type: "busy" } } })).toThrow(/hub session ID/)
    expect(() => spoke.emit({ type: "session.tool.called", data: { sessionID: S1, id: "t1", summary: "x".repeat(161) } })).toThrow(/160/)
    expect(socket.frames.filter((f) => f.t === "event")).toEqual([])
  })

  test("returns false when not connected", () => {
    const { spoke } = make()
    expect(spoke.emit({ type: "session.execution.started", data: { sessionID: S1 } })).toBe(false)
  })
})
