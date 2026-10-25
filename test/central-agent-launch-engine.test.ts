// The launch engine (design §6, §7, §8, §9; decision znbg8xa5): accept → placement → prepare on the node → launch
// create on the service spoke → roles, name, primer → prompt → running; the end watcher (idle only after the prompt
// was seen working, settled, nothing open; asked → needs_user; never; timeout → stop; lost), stop with cleanup, and
// restart recovery. The node, the registry, the directory, delivery, Decisions and actions are fakes here; the
// store, placement and backends are the real in-memory ones.
import { describe, expect, test } from "bun:test"
import { AgentError } from "../src/central/agent/errors"
import { LaunchEngine, type LaunchEngineDeps } from "../src/central/agent/launch-engine"
import type { Launch } from "../src/central/agent/launch-store"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import type { Timers } from "../src/central/backend/types"
import { NodeRegistry } from "../src/central/nodes"
import type { NodeHello, NodeRequest, ServerRequest } from "../src/protocol"

const U = "u1"
const T0 = 1_700_000_000_000
const MACHINE = "m1"
const SERVICE = "conn-svc"

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A clock with timers that fire when the test advances it. */
function fakeClock() {
  let t = T0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++seq
      pending.set(id, { at: t + ms, fn })
      return id
    },
    clear: (handle) => void pending.delete(handle as number),
  }
  return {
    now: () => t,
    timers,
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...pending].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        t = Math.max(t, due[1].at)
        due[1].fn()
        await settle()
      }
      t = end
      await settle()
    },
  }
}

const nodeHello = (extra: Partial<NodeHello> = {}): NodeHello => ({
  t: "hello",
  v: 1,
  role: "node",
  instanceID: "inst_1",
  nodeVersion: "1.0.0",
  runtimes: [{ kind: "host", harnesses: ["opencode"] }],
  labels: { os: "darwin" },
  capacity: { slots: 4 },
  used: { slots: 0 },
  workspaceRoots: ["/p"],
  draining: false,
  launches: [],
  ...extra,
})

interface FakeSession {
  state: "idle" | "working" | "blocked" | "error"
  blockers: { kind: string; id: string }[]
  /** Idle by real evidence (Registry.idle). */
  idle: boolean
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

/** The world around the engine. Node ops and spoke requests answer at once unless a test holds them. */
function world(options: { deps?: Partial<LaunchEngineDeps>; service?: boolean; launchFeature?: boolean } = {}) {
  const clock = fakeClock()
  const state = new MemoryStateStore()
  const owners = new Map<string, string>([[MACHINE, U]])
  const nodes = new NodeRegistry((machineID) => owners.get(machineID), clock.now)
  const nodeCalls: NodeRequest[] = []
  const nodeHolds = new Map<string, Deferred<unknown>>()
  let nodeConn: string | undefined
  const prepared = (req: Extract<NodeRequest, { op: "prepare" }>) => ({
    workspace: { repo: req.workspace.repo, directory: `${req.workspace.repo}/.worktrees/${req.workspace.branch}`, mode: req.workspace.mode, ...(req.workspace.branch ? { branch: req.workspace.branch } : {}), ...(req.workspace.base ? { base: req.workspace.base } : {}), reused: false },
  })
  const nodeAnswers: { [op: string]: (req: any) => unknown } = {
    prepare: prepared,
    collect: () => ({ artifacts: { branch: "feat/x", base: "main", head: "abcdef1", commits: 2, dirty: false } }),
    cleanup: (req: any) => (req.policy === "remove" ? { removed: true } : { removed: false, reason: "cleanup policy is keep" }),
    cancel: () => ({ cancelled: true }),
  }
  const nodeOps = {
    async requestNode(connID: string, req: NodeRequest): Promise<any> {
      if (connID !== nodeConn || !nodes.get(connID)) throw new Error("The node disconnected")
      nodeCalls.push(req)
      const hold = nodeHolds.get(req.op)
      if (hold) {
        nodeHolds.delete(req.op)
        return hold.promise
      }
      return nodeAnswers[req.op]!(req)
    },
  }
  const sessions = new Map<string, FakeSession>()
  const statusListeners = new Set<(message: any, tenant?: string) => void>()
  let serviceConn: string | undefined = options.service === false ? undefined : SERVICE
  const features = new Set<string>(options.launchFeature === false ? [] : ["launch"])
  const spokeCalls: ServerRequest[] = []
  let sessionSeq = 0
  const spokeAnswers: { create: (req: any) => unknown } = {
    create: () => {
      const id = `ses_${++sessionSeq}`
      sessions.set(id, { state: "idle", blockers: [], idle: true })
      return { sessionID: id }
    },
  }
  const registry = {
    serviceFor: (machineID: string) => (machineID === MACHINE ? serviceConn : undefined),
    supports: (connID: string, feature: string) => connID === serviceConn && features.has(feature),
    connTenant: (connID: string) => (connID === serviceConn ? U : undefined),
    hasSession: (id: string) => sessions.has(id),
    idle: (id: string) => sessions.get(id)?.idle === true,
    session: (id: string) => {
      const s = sessions.get(id)
      return s && ({ id, state: s.state, blockers: s.blockers.map((b) => ({ ...b, sessionID: id, sessionTitle: "" })) } as any)
    },
    subscribe(listener: (message: any, tenant?: string) => void) {
      statusListeners.add(listener)
      return () => void statusListeners.delete(listener)
    },
    onSessions: (_listener: (connID: string) => void) => () => {},
  }
  const spokes = {
    async request(connID: string, req: ServerRequest): Promise<any> {
      if (connID !== serviceConn) throw new Error("OpenCode process disconnected")
      spokeCalls.push(req)
      if (req.op === "create") return spokeAnswers.create(req)
      return {}
    },
  }
  const names = new Map<string, string>()
  const roles: { sessionID: string; role: string; byUser?: boolean }[] = []
  const directory = {
    sync: (_userID: string) => {},
    setName(_userID: string, sessionID: string, name: string) {
      if ([...names].some(([n, s]) => n === name && s !== sessionID)) throw new AgentError("name_taken", `@${name} is taken`)
      names.set(name, sessionID)
      primeOrder.push(`name:${name}`)
      return { sessionID, name }
    },
    claimRole(_userID: string, sessionID: string, role: string, opts: { byUser?: boolean } = {}) {
      roles.push({ sessionID, role, ...(opts.byUser ? { byUser: true } : {}) })
      primeOrder.push(`role:${role}`)
      return { role, generation: 1 } as any
    },
    resolve(_userID: string, addr: string) {
      const sessionID = names.get(addr.replace(/^@/, ""))
      if (!sessionID) throw new AgentError("not_found", `No session ${addr}`)
      return { address: { kind: "name", name: addr } as any, sessions: [{ sessionID, online: true, roles: [] }] }
    },
  }
  const primeOrder: string[] = []
  const waiting = new Map<string, number>()
  const delivery = {
    async prime(_userID: string, sessionID: string) {
      primeOrder.push(`prime:${sessionID}`)
    },
    messages: {
      async inbox(_userID: string, party: any) {
        const n = waiting.get(party.sessionID) ?? 0
        return { asks: [], waiting: Array.from({ length: n }, () => ({}) as any), messages: [] }
      },
    },
  }
  const openDecisions = new Map<string, number>()
  const decisions = {
    async list(_userID: string, filter: any) {
      const n = filter.state === "open" ? (openDecisions.get(filter.from?.sessionID) ?? 0) : 0
      return Array.from({ length: n }, () => ({}) as any)
    },
  }
  const prompts: { sessionID: string; text: string; resetHops: boolean }[] = []
  const stops: string[] = []
  let promptOutcome: "turn" | "steer" | "offline" = "turn"
  const turn = deferred<any>()
  const actions = {
    async prompt(input: { sessionID: string; text: string; resetHops: boolean }): Promise<any> {
      prompts.push({ sessionID: input.sessionID, text: input.text, resetHops: input.resetHops })
      primeOrder.push(`prompt:${input.sessionID}`)
      if (promptOutcome === "offline") return { outcome: "offline" }
      if (promptOutcome === "steer") return { outcome: "done", mode: "steer", inboxID: "i1" }
      return { outcome: "done", mode: "turn", result: turn.promise }
    },
    async stop(sessionID: string): Promise<any> {
      stops.push(sessionID)
      const s = sessions.get(sessionID)
      if (s) Object.assign(s, { state: "idle", idle: true })
      return { outcome: "done", result: { stopped: [sessionID] } }
    },
  }
  const changes: Launch[] = []
  const deps: LaunchEngineDeps = {
    state,
    counters: new MemoryCounters({ now: clock.now }),
    locks: new MemoryLocks({ now: clock.now }),
    owner: "pod-1",
    nodes,
    nodeOps,
    registry,
    spokes,
    directory,
    delivery,
    decisions,
    actions,
    users: async () => [U],
    now: clock.now,
    timers: clock.timers,
    onLaunchChanged: (launch) => void changes.push(launch),
    ...options.deps,
  }
  const engine = new LaunchEngine(deps)
  const w = {
    clock,
    state,
    nodes,
    nodeCalls,
    nodeHolds,
    nodeAnswers,
    sessions,
    spokeCalls,
    spokeAnswers,
    names,
    roles,
    primeOrder,
    waiting,
    openDecisions,
    prompts,
    stops,
    turn,
    changes,
    deps,
    engine,
    features,
    setPrompt(outcome: "turn" | "steer" | "offline") {
      promptOutcome = outcome
    },
    setService(conn: string | undefined) {
      serviceConn = conn
    },
    /** Connects the node (a NodeRegistry connection). */
    connectNode(extra: Partial<NodeHello> = {}, connID = "conn-node") {
      nodeConn = connID
      return nodes.connect(connID, { id: MACHINE, name: "mbp" }, nodeHello(extra))
    },
    disconnectNode() {
      if (nodeConn) nodes.disconnect(nodeConn)
      nodeConn = undefined
    },
    /** Sets the session's live state and tells the engine's registry listeners. */
    setSession(id: string, change: Partial<FakeSession>) {
      const s = sessions.get(id) ?? { state: "idle", blockers: [], idle: true }
      Object.assign(s, change)
      sessions.set(id, s)
      for (const listener of statusListeners) listener({ type: "status", sessionID: id, sessions: [{ id, state: s.state, blockers: s.blockers }] }, U)
    },
    dropSession(id: string) {
      sessions.delete(id)
      for (const listener of statusListeners) listener({ type: "catalog" })
    },
    launch: (id: string) => engine.store.get(U, id),
  }
  return w
}

type World = ReturnType<typeof world>

const body = (extra: Record<string, unknown> = {}) => ({ workspace: { repo: "/p/hub", branch: "feat/x", base: "main" }, prompt: "Do the thing", ...extra })

/** Accepts a launch and lets placement and provisioning run. */
async function launched(w: World, extra: Record<string, unknown> = {}): Promise<Launch> {
  const { launch } = await w.engine.accept(U, body(extra), { by: "user" })
  await settle()
  return (await w.launch(launch.id))!
}

describe("accept", () => {
  test("validates and queues a launch, tells onLaunchChanged, and is idempotent by key", async () => {
    const w = world()
    const first = await w.engine.accept(U, body({ key: "k1" }), { by: "app:t1" })
    expect(first.created).toBe(true)
    expect(first.launch).toMatchObject({ owner: U, state: "queued", by: "app:t1", spec: { workspace: { repo: "/p/hub" }, prompt: "Do the thing" } })
    expect(w.changes.map((l) => l.state)).toContain("queued")
    const again = await w.engine.accept(U, body({ key: "k1" }), { by: "app:t1" })
    expect(again).toMatchObject({ created: false, launch: { id: first.launch.id } })
  })

  test("an invalid body is invalid and stores nothing", async () => {
    const w = world()
    await expect(w.engine.accept(U, { workspace: { repo: "relative" } })).rejects.toMatchObject({ code: "invalid" })
    expect(await w.engine.store.list(U)).toEqual([])
  })

  test("a name held by a session or by another live launch is name_taken", async () => {
    const w = world()
    w.names.set("api", "ses_other")
    await expect(w.engine.accept(U, body({ name: "api" }))).rejects.toMatchObject({ code: "name_taken" })
    await w.engine.accept(U, body({ name: "web" }))
    await expect(w.engine.accept(U, body({ name: "web" }))).rejects.toMatchObject({ code: "name_taken" })
  })

  test("the queue cap refuses a new launch with rate_limited, but an idempotent retry still gets its launch", async () => {
    const w = world({ deps: { caps: { maxQueued: 1 } } })
    const first = await w.engine.accept(U, body({ key: "k1" }))
    await expect(w.engine.accept(U, body({ key: "k2" }))).rejects.toMatchObject({ code: "rate_limited" })
    expect((await w.engine.accept(U, body({ key: "k1" }))).launch.id).toBe(first.launch.id)
  })
})
