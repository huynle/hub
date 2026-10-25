// The launch engine (design §6, §7, §8, §9; decision znbg8xa5): accept → placement → prepare on the node → launch
// create on the service spoke → roles, name, primer → prompt → running; the end watcher (idle only after the prompt
// was seen working, settled, nothing open; asked → needs_user; never; timeout → stop; lost), stop with cleanup, and
// restart recovery. The node, the registry, the directory, delivery, Decisions and actions are fakes here; the
// store, placement and backends are the real in-memory ones.
import { describe, expect, test } from "bun:test"
import { AgentError } from "../src/central/agent/errors"
import { LAUNCH_WORK, LaunchEngine, type LaunchEngineDeps } from "../src/central/agent/launch-engine"
import { validateLaunchSpec } from "../src/central/agent/launch-spec"
import type { Launch } from "../src/central/agent/launch-store"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import type { Timers } from "../src/central/backend/types"
import { NodeRegistry } from "../src/central/nodes"
import { LaunchStore } from "../src/central/agent/launch-store"
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
    /** Lets pending work settle (at the current time), then moves the clock, running due timers in order. */
    async advance(ms: number) {
      await settle()
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
  let serviceHarness = "opencode"
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
    serviceFor: (machineID: string, harness = "opencode") => (machineID === MACHINE && harness === serviceHarness ? serviceConn : undefined),
    serviceHarnesses: (machineID: string) => (machineID === MACHINE && serviceConn !== undefined ? [serviceHarness] : []),
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
    launchConn: (_launchID: string) => undefined,
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
    sync: async (_userID: string) => {},
    async setName(_userID: string, sessionID: string, name: string) {
      if ([...names].some(([n, s]) => n === name && s !== sessionID)) throw new AgentError("name_taken", `@${name} is taken`)
      names.set(name, sessionID)
      primeOrder.push(`name:${name}`)
      return { sessionID, name }
    },
    async claimRole(_userID: string, sessionID: string, role: string, opts: { byUser?: boolean } = {}) {
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
  let promptOutcome: "turn" | "steer" | "offline" | "unsupported" = "turn"
  const turn = deferred<any>()
  const actions = {
    async prompt(input: { sessionID: string; text: string; resetHops: boolean }): Promise<any> {
      prompts.push({ sessionID: input.sessionID, text: input.text, resetHops: input.resetHops })
      primeOrder.push(`prompt:${input.sessionID}`)
      if (promptOutcome === "offline") return { outcome: "offline" }
      if (promptOutcome === "unsupported") return { outcome: "unsupported", feature: "turn", harness: "claude-code" }
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
    setPrompt(outcome: "turn" | "steer" | "offline" | "unsupported") {
      promptOutcome = outcome
    },
    setService(conn: string | undefined, harness = "opencode") {
      serviceConn = conn
      serviceHarness = harness
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

describe("provisioning", () => {
  test("prepare on the node → launch create on the service spoke → roles, name, primer → prompt → running", async () => {
    const w = world()
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w, { name: "api", roles: ["reviewer.hub"], agent: "build", model: "anthropic/claude-x#high", labels: { app: "brain" } })
    expect(launch).toMatchObject({ state: "running", machineID: MACHINE, sessionID: "ses_1", name: "api" })
    expect(w.nodeCalls[0]).toEqual({
      op: "prepare",
      launchID: launch.id,
      runtime: { kind: "host" },
      harness: "opencode",
      workspace: { repo: "/p/hub", mode: "worktree", branch: "feat/x", base: "main" },
    })
    expect(w.spokeCalls[0]).toEqual({
      op: "create",
      directory: "/p/hub/.worktrees/feat/x",
      title: "api",
      launchID: launch.id,
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-x", variant: "high" },
    })
    expect(w.roles).toEqual([{ sessionID: "ses_1", role: "reviewer.hub", byUser: true }])
    expect(w.primeOrder).toEqual(["role:reviewer.hub", "name:api", "prime:ses_1", "prompt:ses_1"])
    expect(w.prompts).toEqual([{ sessionID: "ses_1", text: "Do the thing", resetHops: false }])
    expect(w.changes.map((l) => l.state)).toEqual(["queued", "provisioning", "running"])
    expect(await w.engine.view(U, launch.id)).toMatchObject({ id: launch.id, directory: "/p/hub/.worktrees/feat/x" })
    w.engine.shutdown()
  })

  test("a launch's harness picks the machine's service spoke of that harness", async () => {
    const w = world()
    w.setService(SERVICE, "claude-code")
    w.connectNode({ runtimes: [{ kind: "host", harnesses: ["opencode", "claude-code"] }] })
    await w.engine.start()
    const launch = await launched(w, { harness: "claude-code" })
    expect(launch).toMatchObject({ state: "running", sessionID: "ses_1" })
    expect(w.nodeCalls[0]).toMatchObject({ op: "prepare", harness: "claude-code" })
    expect(w.spokeCalls[0]).toMatchObject({ op: "create", launchID: launch.id })
    w.engine.shutdown()
  })

  test("an OpenCode launch waits while the machine has only another harness's service spoke", async () => {
    const w = world()
    w.setService(SERVICE, "claude-code")
    w.connectNode({ runtimes: [{ kind: "host", harnesses: ["opencode", "claude-code"] }] })
    await w.engine.start()
    const launch = await launched(w)
    expect(launch.state).toBe("queued")
    expect(w.spokeCalls).toEqual([])
    w.setService(SERVICE, "opencode")
    w.engine.kick(U)
    await settle()
    expect(await w.launch(launch.id)).toMatchObject({ state: "running" })
    w.engine.shutdown()
  })

  test("an app's launch claims roles without user powers; no name: primed explicitly", async () => {
    const w = world()
    w.connectNode()
    await w.engine.start()
    const { launch } = await w.engine.accept(U, body({ roles: ["reviewer"] }), { by: "app:t1" })
    await settle()
    expect(await w.launch(launch.id)).toMatchObject({ state: "running", sessionID: "ses_1" })
    expect(w.roles).toEqual([{ sessionID: "ses_1", role: "reviewer" }])
    expect(w.primeOrder).toEqual(["role:reviewer", "prime:ses_1", "prompt:ses_1"])
    w.engine.shutdown()
  })

  test("waits queued without a node; a node connecting places it", async () => {
    const w = world()
    await w.engine.start()
    const queued = await launched(w)
    expect(queued.state).toBe("queued")
    w.connectNode()
    await settle()
    expect(await w.launch(queued.id)).toMatchObject({ state: "running" })
    w.engine.shutdown()
  })

  test("a role the directory refuses does not fail the launch; it is noted in the reason", async () => {
    const w = world()
    w.deps.directory.claimRole = async () => {
      throw new AgentError("name_taken", "@@lead is held exclusively by another session")
    }
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w, { roles: ["lead"] })
    expect(launch.state).toBe("running")
    expect(launch.reason).toContain("@@lead")
    w.engine.shutdown()
  })
})

describe("provisioning failures", () => {
  test("a failed prepare ends the launch failed with the node's reason; nothing is created", async () => {
    const w = world()
    w.nodeAnswers.prepare = () => {
      throw new Error("git worktree add failed")
    }
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    expect(launch).toMatchObject({ state: "ended", outcome: "failed" })
    expect(launch.reason).toContain("git worktree add failed")
    expect(w.spokeCalls).toEqual([])
    expect(w.changes.at(-1)).toMatchObject({ id: launch.id, state: "ended" })
    w.engine.shutdown()
  })

  test("the node going away during prepare ends the launch lost", async () => {
    const w = world()
    const hold = deferred<unknown>()
    w.nodeHolds.set("prepare", hold)
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    expect(launch.state).toBe("provisioning")
    w.disconnectNode()
    hold.reject(new Error("The node disconnected"))
    await settle()
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "lost" })
    w.engine.shutdown()
  })

  test("a refused launch create fails the launch and removes the fresh workspace", async () => {
    const w = world()
    w.spokeAnswers.create = () => {
      throw new Error("Unknown agent build")
    }
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w, { agent: "build" })
    expect(launch).toMatchObject({ state: "ended", outcome: "failed" })
    expect(launch.reason).toContain("Unknown agent build")
    const cleanup = w.nodeCalls.find((r) => r.op === "cleanup")
    expect(cleanup).toMatchObject({ op: "cleanup", launchID: launch.id, policy: "remove", workspace: { directory: "/p/hub/.worktrees/feat/x" } })
    w.engine.shutdown()
  })

  test("the service spoke going away before create fails the launch", async () => {
    const w = world()
    const hold = deferred<unknown>()
    w.nodeHolds.set("prepare", hold)
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    w.setService(undefined)
    hold.resolve(w.nodeAnswers.prepare!(w.nodeCalls[0]))
    await settle()
    const ended = (await w.launch(launch.id))!
    expect(ended).toMatchObject({ state: "ended", outcome: "failed" })
    expect(ended.reason).toContain("service spoke")
    w.engine.shutdown()
  })

  test("a name taken meanwhile fails the launch; the session is never prompted", async () => {
    const w = world()
    w.connectNode()
    await w.engine.start()
    const { launch } = await w.engine.accept(U, body({ name: "api" }))
    w.names.set("api", "ses_other")
    await settle()
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "failed" })
    expect(w.prompts).toEqual([])
    w.engine.shutdown()
  })

  test("a session offline at prompt time fails the launch", async () => {
    const w = world()
    w.setPrompt("offline")
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    expect(launch).toMatchObject({ state: "ended", outcome: "failed" })
    w.engine.shutdown()
  })

  test("a spoke that cannot run the prompt's turn fails the launch, naming the feature and harness", async () => {
    const w = world()
    w.setPrompt("unsupported")
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    expect(launch).toMatchObject({ state: "ended", outcome: "failed" })
    expect(launch.reason).toContain("The claude-code spoke does not support turn")
    w.engine.shutdown()
  })
})

/** A running launch on a fresh world (started engine, connected node). */
async function running(extra: Record<string, unknown> = {}, options: Parameters<typeof world>[0] = {}) {
  const w = world(options)
  w.connectNode()
  await w.engine.start()
  const launch = await launched(w, extra)
  expect(launch.state).toBe("running")
  return { w, launch, sessionID: launch.sessionID! }
}

describe("end watcher", () => {
  test("idle ends only after the prompt was seen working, then 30 s settled; artifacts collected, workspace kept", async () => {
    const { w, launch, sessionID } = await running()
    await w.clock.advance(120_000)
    expect((await w.launch(launch.id))!.state).toBe("running")
    w.setSession(sessionID, { state: "working", idle: false })
    await settle()
    w.setSession(sessionID, { state: "idle", idle: true })
    await w.clock.advance(29_000)
    expect((await w.launch(launch.id))!.state).toBe("running")
    await w.clock.advance(2_000)
    const ended = (await w.launch(launch.id))!
    expect(ended).toMatchObject({ state: "ended", outcome: "idle", artifacts: { branch: "feat/x", head: "abcdef1", commits: 2, dirty: false } })
    expect(ended.reason).toContain("workspace kept")
    expect(w.nodeCalls.filter((r) => r.op !== "prepare").map((r) => [r.op, (r as any).policy])).toEqual([["collect", undefined], ["cleanup", "keep"]])
    expect(w.stops).toEqual([])
    w.engine.shutdown()
  })

  test("working again during the settle starts it over", async () => {
    const { w, launch, sessionID } = await running()
    w.setSession(sessionID, { state: "working", idle: false })
    w.setSession(sessionID, { state: "idle", idle: true })
    await w.clock.advance(20_000)
    w.setSession(sessionID, { state: "working", idle: false })
    w.setSession(sessionID, { state: "idle", idle: true })
    await w.clock.advance(20_000)
    expect((await w.launch(launch.id))!.state).toBe("running")
    await w.clock.advance(11_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "idle" })
    w.engine.shutdown()
  })

  test("the prompt's turn finishing counts as seen working", async () => {
    const { w, launch } = await running()
    w.turn.resolve({ outcome: "succeeded", reply: "done" })
    await settle()
    await w.clock.advance(31_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "idle" })
    w.engine.shutdown()
  })

  test("blockers, the session's open asks and its open Decisions hold an idle end", async () => {
    const { w, launch, sessionID } = await running()
    w.setSession(sessionID, { state: "working", idle: false })
    w.setSession(sessionID, { state: "blocked", idle: false, blockers: [{ kind: "permission", id: "p1" }] })
    await w.clock.advance(120_000)
    w.waiting.set(sessionID, 1)
    w.setSession(sessionID, { state: "idle", idle: true, blockers: [] })
    await w.clock.advance(120_000)
    w.waiting.set(sessionID, 0)
    w.openDecisions.set(sessionID, 1)
    await w.clock.advance(120_000)
    expect((await w.launch(launch.id))!.state).toBe("running")
    w.openDecisions.set(sessionID, 0)
    await w.clock.advance(60_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "idle" })
    w.engine.shutdown()
  })

  test("asked: a question left open ends needs_user, session and workspace kept", async () => {
    const { w, launch, sessionID } = await running({ end: { when: "asked", cleanup: "remove" } })
    w.setSession(sessionID, { state: "working", idle: false })
    w.setSession(sessionID, { state: "blocked", idle: false, blockers: [{ kind: "question", id: "q1" }] })
    await w.clock.advance(31_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "needs_user" })
    expect(w.nodeCalls.find((r) => r.op === "cleanup")).toMatchObject({ policy: "keep" })
    expect(w.stops).toEqual([])
    w.engine.shutdown()
  })

  test("asked: an open Decision while idle ends needs_user; plain idle still ends idle", async () => {
    const asked = await running({ end: { when: "asked" } })
    asked.w.setSession(asked.sessionID, { state: "working", idle: false })
    asked.w.openDecisions.set(asked.sessionID, 1)
    asked.w.setSession(asked.sessionID, { state: "idle", idle: true })
    await asked.w.clock.advance(31_000)
    expect(await asked.w.launch(asked.launch.id)).toMatchObject({ outcome: "needs_user" })
    asked.w.engine.shutdown()
    const plain = await running({ end: { when: "asked" } })
    plain.w.setSession(plain.sessionID, { state: "working", idle: false })
    plain.w.setSession(plain.sessionID, { state: "idle", idle: true })
    await plain.w.clock.advance(31_000)
    expect(await plain.w.launch(plain.launch.id)).toMatchObject({ outcome: "idle" })
    plain.w.engine.shutdown()
  })

  test("never: idle does not end it", async () => {
    const { w, launch, sessionID } = await running({ end: { when: "never" } })
    w.setSession(sessionID, { state: "working", idle: false })
    w.setSession(sessionID, { state: "idle", idle: true })
    await w.clock.advance(600_000)
    expect((await w.launch(launch.id))!.state).toBe("running")
    w.engine.shutdown()
  })

  test("timeout stops the session and ends the launch timeout, removing the workspace when asked", async () => {
    const { w, launch, sessionID } = await running({ end: { when: "never", timeout: "2m", cleanup: "remove" } })
    await w.clock.advance(119_000)
    expect((await w.launch(launch.id))!.state).toBe("running")
    await w.clock.advance(2_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "timeout" })
    expect(w.stops).toEqual([sessionID])
    expect(w.nodeCalls.find((r) => r.op === "cleanup")).toMatchObject({ policy: "remove" })
    w.engine.shutdown()
  })

  test("a session unreported for 10 minutes is lost; one that comes back is not", async () => {
    const { w, launch, sessionID } = await running({ end: { when: "never" } })
    w.dropSession(sessionID)
    await w.clock.advance(300_000)
    w.setSession(sessionID, { state: "idle", idle: true })
    await w.clock.advance(600_000)
    expect((await w.launch(launch.id))!.state).toBe("running")
    w.dropSession(sessionID)
    await w.clock.advance(601_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "lost" })
    w.engine.shutdown()
  })
})

describe("stop", () => {
  test("a queued launch ends stopped at once", async () => {
    const w = world()
    await w.engine.start()
    const queued = await launched(w)
    const stopped = await w.engine.stop(U, queued.id)
    expect(stopped).toMatchObject({ state: "ended", outcome: "stopped" })
    expect(w.changes.at(-1)).toMatchObject({ id: queued.id, outcome: "stopped" })
    w.engine.shutdown()
  })

  test("stopping during prepare cancels it on the node and ends stopped, not failed", async () => {
    const w = world()
    const hold = deferred<unknown>()
    w.nodeHolds.set("prepare", hold)
    w.nodeAnswers.cancel = () => {
      hold.reject(new Error("prepare cancelled"))
      return { cancelled: true }
    }
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    const stopped = await w.engine.stop(U, launch.id)
    expect(stopped).toMatchObject({ state: "ended", outcome: "stopped" })
    expect(w.nodeCalls.map((r) => r.op)).toEqual(["prepare", "cancel"])
    expect(w.spokeCalls).toEqual([])
    w.engine.shutdown()
  })

  test("a stop arriving as prepare finishes still stops before the session is created; the fresh workspace is removed", async () => {
    const w = world()
    const hold = deferred<unknown>()
    w.nodeHolds.set("prepare", hold)
    w.nodeAnswers.cancel = () => {
      hold.resolve(w.nodeAnswers.prepare!(w.nodeCalls[0]))
      return { cancelled: false }
    }
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    expect(await w.engine.stop(U, launch.id)).toMatchObject({ state: "ended", outcome: "stopped" })
    expect(w.spokeCalls).toEqual([])
    expect(w.nodeCalls.find((r) => r.op === "cleanup")).toMatchObject({ policy: "remove" })
    w.engine.shutdown()
  })

  test("a running launch: its session is stopped, artifacts collected, the workspace cleaned up by policy", async () => {
    const { w, launch, sessionID } = await running({ end: { cleanup: "remove" } })
    const stopped = await w.engine.stop(U, launch.id)
    expect(stopped).toMatchObject({ state: "ended", outcome: "stopped", artifacts: { commits: 2 } })
    expect(w.stops).toEqual([sessionID])
    expect(w.nodeCalls.find((r) => r.op === "cleanup")).toMatchObject({ policy: "remove" })
    w.engine.shutdown()
  })

  test("an ended launch is gone; an unknown or another user's launch is not_found", async () => {
    const w = world()
    await w.engine.start()
    const queued = await launched(w)
    await w.engine.stop(U, queued.id)
    await expect(w.engine.stop(U, queued.id)).rejects.toMatchObject({ code: "gone" })
    await expect(w.engine.stop(U, "l_nope")).rejects.toMatchObject({ code: "not_found" })
    await expect(w.engine.stop("u2", queued.id)).rejects.toMatchObject({ code: "not_found" })
    w.engine.shutdown()
  })
})

/** The hub restarts: a new engine over the same state and world. */
async function restart(w: World): Promise<LaunchEngine> {
  w.engine.shutdown()
  const engine = new LaunchEngine(w.deps)
  await engine.start()
  await settle()
  return engine
}

/** A launch left provisioning on the machine by a hub that stopped, with the engine's work record. */
async function leftProvisioning(w: World, work: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Launch> {
  const store = new LaunchStore({ state: w.state, now: w.clock.now })
  const { launch } = await store.create(U, validateLaunchSpec(body(extra)), { by: "user" })
  await store.transition(U, launch.id, "placing", { reason: "Placing on mbp" })
  const provisioning = await store.transition(U, launch.id, "provisioning", { reason: "Placed on mbp", machineID: MACHINE })
  await w.state.put(U, LAUNCH_WORK, launch.id, work)
  return provisioning
}

const preparedWorkspace = { repo: "/p/hub", directory: "/p/hub/.worktrees/feat/x", mode: "worktree", branch: "feat/x", base: "main", reused: false } as const

describe("restart recovery", () => {
  test("a running launch is watched again: seen working survives, so idle ends it", async () => {
    const { w, launch, sessionID } = await running()
    w.setSession(sessionID, { state: "working", idle: false })
    await settle()
    w.setSession(sessionID, { state: "idle", idle: true })
    await settle()
    await restart(w)
    await w.clock.advance(31_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "idle" })
  })

  test("a running launch's timeout counts from when it started running", async () => {
    const { w, launch } = await running({ end: { when: "never", timeout: "2m" } })
    await w.clock.advance(60_000)
    const engine = await restart(w)
    await w.clock.advance(59_000)
    expect((await w.launch(launch.id))!.state).toBe("running")
    await w.clock.advance(2_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "timeout" })
    engine.shutdown()
  })

  test("queued launches are placed after a restart", async () => {
    const w = world()
    await w.engine.start()
    const queued = await launched(w)
    w.engine.shutdown()
    w.connectNode()
    const engine = await restart(w)
    expect(await w.launch(queued.id)).toMatchObject({ state: "running" })
    engine.shutdown()
  })

  test("provisioning with its session prompted: running, never prompted again", async () => {
    const w = world()
    w.connectNode()
    w.sessions.set("ses_9", { state: "idle", blockers: [], idle: true })
    const launch = await leftProvisioning(w, { workspace: preparedWorkspace, sessionID: "ses_9", prompted: true })
    const engine = await restart(w)
    expect(await w.launch(launch.id)).toMatchObject({ state: "running", sessionID: "ses_9" })
    expect(w.prompts).toEqual([])
    expect(w.nodeCalls).toEqual([])
    engine.shutdown()
  })

  test("provisioning with its workspace prepared: carries on from the launch create", async () => {
    const w = world()
    w.connectNode({ launches: [] })
    const launch = await leftProvisioning(w, { workspace: preparedWorkspace })
    const engine = await restart(w)
    expect(await w.launch(launch.id)).toMatchObject({ state: "running", sessionID: "ses_1" })
    expect(w.nodeCalls).toEqual([])
    expect(w.spokeCalls.map((r) => r.op)).toEqual(["create"])
    expect(w.prompts).toHaveLength(1)
    engine.shutdown()
  })

  test("provisioning, the node reports it prepared: released (kept, as reused) and prepared again", async () => {
    const w = world()
    const launch = await leftProvisioning(w, {})
    w.connectNode({ launches: [{ launchID: launch.id, phase: "prepared", directory: "/p/hub/.worktrees/feat/x" }] })
    const engine = await restart(w)
    expect(w.nodeCalls.map((r) => r.op)).toEqual(["cleanup", "prepare"])
    expect(w.nodeCalls[0]).toMatchObject({ policy: "keep", workspace: { directory: "/p/hub/.worktrees/feat/x", reused: true } })
    expect(await w.launch(launch.id)).toMatchObject({ state: "running" })
    engine.shutdown()
  })

  test("provisioning, the node is still preparing it: cancelled, and prepared again once the node lets it go", async () => {
    const w = world()
    const launch = await leftProvisioning(w, {})
    w.connectNode({ launches: [{ launchID: launch.id, phase: "preparing" }] })
    const engine = await restart(w)
    expect(w.nodeCalls.map((r) => r.op)).toEqual(["cancel"])
    expect((await w.launch(launch.id))!.state).toBe("provisioning")
    w.nodes.progress("conn-node", { t: "progress", launchID: launch.id, phase: "cancelled" })
    await settle()
    expect(w.nodeCalls.map((r) => r.op)).toEqual(["cancel", "prepare"])
    expect(await w.launch(launch.id)).toMatchObject({ state: "running" })
    engine.shutdown()
  })

  test("provisioning, the node is not connected: waits for it, else lost after 5 minutes", async () => {
    const w = world()
    const comes = await leftProvisioning(w, {})
    const engine = await restart(w)
    await w.clock.advance(60_000)
    expect((await w.launch(comes.id))!.state).toBe("provisioning")
    w.connectNode()
    await settle()
    expect(await w.launch(comes.id)).toMatchObject({ state: "running" })
    engine.shutdown()

    const w2 = world()
    const never = await leftProvisioning(w2, {})
    const engine2 = await restart(w2)
    await w2.clock.advance(301_000)
    expect(await w2.launch(never.id)).toMatchObject({ state: "ended", outcome: "lost" })
    engine2.shutdown()
  })

  test("a launch that ended while its node was away is cleaned up when the node comes back", async () => {
    const { w, launch } = await running({ end: { cleanup: "remove" } })
    w.disconnectNode()
    const stopped = await w.engine.stop(U, launch.id)
    expect(stopped.reason).toContain("waits for the node")
    w.connectNode({ launches: [{ launchID: launch.id, phase: "prepared", directory: "/p/hub/.worktrees/feat/x" }] })
    await settle()
    expect(w.nodeCalls.filter((r) => r.op === "cleanup")).toEqual([
      { op: "cleanup", launchID: launch.id, workspace: { ...preparedWorkspace }, policy: "remove" },
    ])
    w.engine.shutdown()
  })
})

describe("reading launches", () => {
  test("list filters by labels and states and adds directories; labelsFor finds a session's launch labels", async () => {
    const w = world()
    w.connectNode()
    await w.engine.start()
    const brain = await launched(w, { labels: { app: "brain", "brain.task": "abc" } })
    await w.clock.advance(1_000)
    const other = await launched(w, { labels: { app: "other" }, workspace: { repo: "/p/web", branch: "feat/y" } })
    const listed = await w.engine.list(U, { labels: { app: "brain" } })
    expect(listed.map((l) => [l.id, l.directory])).toEqual([[brain.id, "/p/hub/.worktrees/feat/x"]])
    expect((await w.engine.list(U, { states: ["running"] })).map((l) => l.id)).toEqual([brain.id, other.id])
    expect(await w.engine.labelsFor(U, brain.sessionID!)).toEqual({ app: "brain", "brain.task": "abc" })
    expect(await w.engine.labelsFor(U, "ses_unknown")).toBeUndefined()
    expect(await w.engine.list("u2")).toEqual([])
    w.engine.shutdown()
  })
})

describe("cluster: the supervisor runs on the leader pod", () => {
  test("an engine that does not supervise queues an accepted launch and kicks the supervisor instead of placing it", async () => {
    const kicks: string[] = []
    const w = world({ deps: { supervisor: { kick: (userID) => void kicks.push(userID), stop: async () => undefined } } })
    w.connectNode()
    const queued = await launched(w)
    expect(queued.state).toBe("queued")
    expect(kicks).toEqual([U])
    expect(w.nodeCalls).toEqual([])
    // Elected: it supervises now and places the launch.
    await w.engine.start()
    await settle()
    expect(await w.launch(queued.id)).toMatchObject({ state: "running" })
    w.engine.shutdown()
  })

  test("a stop on a pod that does not supervise goes to the supervisor for provisioning and running launches", async () => {
    const forwarded: string[] = []
    const { w, launch, sessionID } = await running()
    const follower = new LaunchEngine({
      ...w.deps,
      supervisor: {
        kick: () => {},
        stop: (userID, id, reason) => (forwarded.push(id), w.engine.stop(userID, id, reason)),
      },
    })
    expect(await follower.stop(U, launch.id)).toMatchObject({ state: "ended", outcome: "stopped" })
    expect(forwarded).toEqual([launch.id])
    expect(w.stops).toEqual([sessionID])
    // A queued one ends where it is asked.
    w.disconnectNode()
    const queued = (await follower.accept(U, body())).launch
    expect(await follower.stop(U, queued.id)).toMatchObject({ state: "ended", outcome: "stopped" })
    expect(forwarded).toEqual([launch.id])
    // No supervisor answers: the pod ends it itself.
    w.connectNode()
    w.engine.shutdown()
    const alone = new LaunchEngine({ ...w.deps, supervisor: { kick: () => {}, stop: async () => undefined } })
    await alone.start()
    const next = await launched({ ...w, engine: alone })
    expect(next.state).toBe("running")
    alone.shutdown()
    const follower2 = new LaunchEngine({ ...w.deps, supervisor: { kick: () => {}, stop: async () => undefined } })
    expect(await follower2.stop(U, next.id)).toMatchObject({ state: "ended", outcome: "stopped" })
  })

  test("a deposed engine abandons its provisioning runs (the launch is not ended); the next leader carries on", async () => {
    const w = world()
    const hold = deferred<unknown>()
    w.nodeHolds.set("prepare", hold)
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    expect(launch.state).toBe("provisioning")
    w.engine.shutdown()
    hold.resolve(w.nodeAnswers.prepare!(w.nodeCalls[0]))
    await settle()
    expect(await w.launch(launch.id)).toMatchObject({ state: "provisioning" })
    expect(w.spokeCalls).toEqual([])
    const next = await restart(w)
    await settle()
    expect(await w.launch(launch.id)).toMatchObject({ state: "running" })
    expect(w.spokeCalls.filter((r) => r.op === "create")).toHaveLength(1)
    expect(w.prompts).toHaveLength(1)
    expect(w.nodeCalls.filter((r) => r.op === "prepare")).toHaveLength(1)
    next.shutdown()
  })
})
