// The launch engine with the openshell runtime (design §6.3, §6.4; decision lk6gn3u7): prepare on the node → a
// launch-bound token (hlt1) → node start (the node runs the harness in its sandbox, whose spoke connects back with
// that token) → wait for the launch-bound connection (LAUNCH_CONNECT_MS) → launch create on THAT connection →
// roles, name, primer → prompt → running; the end stops the harness on the node before collect and cleanup;
// restart recovery and reconcile know about started sandboxes; a short gap of the sandbox's spoke is not lost.
// The node, the launch-bound spoke, the registry, the directory, delivery, Decisions, actions and the token minter
// are fakes; the store, placement and backends are the real in-memory ones.
import { describe, expect, test } from "bun:test"
import { AgentError } from "../src/central/agent/errors"
import { LAUNCH_CONNECT_MS, LAUNCH_WORK, LaunchEngine, type LaunchEngineDeps } from "../src/central/agent/launch-engine"
import { validateLaunchSpec } from "../src/central/agent/launch-spec"
import { type Launch, LaunchStore } from "../src/central/agent/launch-store"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"
import type { Timers } from "../src/central/backend/types"
import { NodeRegistry } from "../src/central/nodes"
import type { NodeHello, NodeRequest, PreparedWorkspace, ServerRequest } from "../src/protocol"

const U = "u1"
const T0 = 1_700_000_000_000
const MACHINE = "m1"
const HUB_URL = "http://127.0.0.1:4096"
const SANDBOX = "hub-0123456789abcdef0123"

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
  features: ["sandbox"],
  runtimes: [{ kind: "openshell", harnesses: ["opencode"], profiles: ["net-off"] }],
  labels: { os: "linux" },
  capacity: { slots: 4 },
  used: { slots: 0 },
  workspaceRoots: ["/p"],
  draining: false,
  launches: [],
  ...extra,
})

const sandboxWorkspace: PreparedWorkspace = {
  repo: "/p/hub",
  directory: "/sandbox/work",
  mode: "clone",
  branch: "feat/x",
  base: "main",
  reused: false,
  runtime: { kind: "openshell", sandbox: SANDBOX, profile: "net-off" },
}

interface FakeSession {
  state: "idle" | "working" | "blocked" | "error"
  blockers: { kind: string; id: string }[]
  idle: boolean
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

/**
 * The world around the engine: a node serving sandboxes (its start connects the launch's spoke at once unless
 * `connectOnStart` is false), launch-bound spoke connections, no service spoke.
 */
function world(options: { deps?: Partial<LaunchEngineDeps> } = {}) {
  const clock = fakeClock()
  const state = new MemoryStateStore()
  const owners = new Map<string, string>([[MACHINE, U]])
  const nodes = new NodeRegistry((machineID) => owners.get(machineID), clock.now)
  const nodeCalls: NodeRequest[] = []
  const nodeHolds = new Map<string, Deferred<unknown>>()
  let nodeConn: string | undefined
  const catalog = new Set<(message: any, tenant?: string) => void>()
  /** Launch-bound connections by launch ID. */
  const launchConns = new Map<string, string>()
  let connSeq = 0
  const connectLaunch = (launchID: string) => {
    launchConns.set(launchID, `conn-launch-${++connSeq}`)
    for (const listener of [...catalog]) listener({ type: "catalog" })
  }
  const dropLaunch = (launchID: string) => {
    launchConns.delete(launchID)
    for (const listener of [...catalog]) listener({ type: "catalog" })
  }
  const control = { connectOnStart: true }
  const nodeAnswers: { [op: string]: (req: any) => unknown } = {
    prepare: () => ({ workspace: sandboxWorkspace }),
    start: (req: any) => {
      if (control.connectOnStart) connectLaunch(req.launchID)
      return { started: true }
    },
    stop: () => ({ stopped: true }),
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
  const isLaunchConn = (connID: string) => [...launchConns.values()].includes(connID)
  const spokeCalls: { connID: string; req: ServerRequest }[] = []
  let sessionSeq = 0
  const spokeAnswers: { create: (req: any) => unknown } = {
    create: () => {
      const id = `ses_${++sessionSeq}`
      sessions.set(id, { state: "idle", blockers: [], idle: true })
      return { sessionID: id }
    },
  }
  const registry = {
    serviceFor: (_machineID: string) => undefined,
    supports: (connID: string, feature: string) => isLaunchConn(connID) && feature === "launch",
    connTenant: (connID: string) => (isLaunchConn(connID) ? U : undefined),
    launchConn: (launchID: string) => launchConns.get(launchID),
    hasSession: (id: string) => sessions.has(id),
    idle: (id: string) => sessions.get(id)?.idle === true,
    session: (id: string) => {
      const s = sessions.get(id)
      return s && ({ id, state: s.state, blockers: s.blockers.map((b) => ({ ...b, sessionID: id, sessionTitle: "" })) } as any)
    },
    subscribe(listener: (message: any, tenant?: string) => void) {
      catalog.add(listener)
      return () => void catalog.delete(listener)
    },
    onSessions: (_listener: (connID: string) => void) => () => {},
  }
  const spokes = {
    async request(connID: string, req: ServerRequest): Promise<any> {
      if (!isLaunchConn(connID)) throw new Error("OpenCode process disconnected")
      spokeCalls.push({ connID, req })
      if (req.op === "create") return spokeAnswers.create(req)
      return {}
    },
  }
  const names = new Map<string, string>()
  const primeOrder: string[] = []
  const directory = {
    sync: (_userID: string) => {},
    setName(_userID: string, sessionID: string, name: string) {
      names.set(name, sessionID)
      primeOrder.push(`name:${name}`)
      return { sessionID, name }
    },
    claimRole(_userID: string, sessionID: string, role: string) {
      primeOrder.push(`role:${role}`)
      return { role, generation: 1, sessionID } as any
    },
    resolve(_userID: string, addr: string): any {
      throw new AgentError("not_found", `No session ${addr}`)
    },
  }
  const delivery = {
    async prime(_userID: string, sessionID: string) {
      primeOrder.push(`prime:${sessionID}`)
    },
    messages: { inbox: async () => ({ asks: [], waiting: [], messages: [] }) as any },
  }
  const decisions = { list: async () => [] as any[] }
  const prompts: { sessionID: string; text: string }[] = []
  const stops: string[] = []
  const turn = deferred<any>()
  const actions = {
    async prompt(input: { sessionID: string; text: string; resetHops: boolean }): Promise<any> {
      prompts.push({ sessionID: input.sessionID, text: input.text })
      primeOrder.push(`prompt:${input.sessionID}`)
      return { outcome: "done", mode: "turn", result: turn.promise }
    },
    async stop(sessionID: string): Promise<any> {
      stops.push(sessionID)
      return { outcome: "done", result: { stopped: [sessionID] } }
    },
  }
  const mints: { machineID: string; launchID: string }[] = []
  let mintSeq = 0
  const tokens = {
    refuse: false,
    async mint(machineID: string, launchID: string) {
      mints.push({ machineID, launchID })
      return tokens.refuse ? undefined : { token: `hlt1.token-${++mintSeq}`, exp: clock.now() + 86_400_000 }
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
    launchTokens: tokens,
    hubURL: HUB_URL,
    users: async () => [U],
    now: clock.now,
    timers: clock.timers,
    onLaunchChanged: (launch) => void changes.push(launch),
    ...options.deps,
  }
  const engine = new LaunchEngine(deps)
  return {
    clock,
    state,
    nodes,
    nodeCalls,
    nodeHolds,
    nodeAnswers,
    sessions,
    spokeCalls,
    spokeAnswers,
    primeOrder,
    prompts,
    stops,
    mints,
    tokens,
    changes,
    deps,
    engine,
    control,
    launchConns,
    connectLaunch,
    dropLaunch,
    connectNode(extra: Partial<NodeHello> = {}, connID = "conn-node") {
      nodeConn = connID
      return nodes.connect(connID, { id: MACHINE, name: "box" }, nodeHello(extra))
    },
    disconnectNode() {
      if (nodeConn) nodes.disconnect(nodeConn)
      nodeConn = undefined
    },
    setSession(id: string, change: Partial<FakeSession>) {
      const s = sessions.get(id) ?? { state: "idle", blockers: [], idle: true }
      Object.assign(s, change)
      sessions.set(id, s)
      for (const listener of catalog) listener({ type: "status", sessionID: id, sessions: [{ id, state: s.state, blockers: s.blockers }] }, U)
    },
    dropSession(id: string) {
      sessions.delete(id)
      for (const listener of catalog) listener({ type: "catalog" })
    },
    launch: (id: string) => engine.store.get(U, id),
    ops: () => nodeCalls.map((r) => r.op),
  }
}

type World = ReturnType<typeof world>

const body = (extra: Record<string, unknown> = {}) => ({
  workspace: { repo: "/p/hub", mode: "clone", remote: "https://github.com/a/b", branch: "feat/x", base: "main" },
  runtime: { kind: "openshell", profile: "net-off" },
  prompt: "Do the thing",
  ...extra,
})

async function launched(w: World, extra: Record<string, unknown> = {}): Promise<Launch> {
  const { launch } = await w.engine.accept(U, body(extra), { by: "user" })
  await settle()
  return (await w.launch(launch.id))!
}

describe("openshell provisioning", () => {
  test("prepare → hlt1 for the launch → node start with the hub URL and token → create on the launch-bound connection → running", async () => {
    const w = world()
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w, { name: "api", roles: ["reviewer"], agent: "build" })
    expect(launch).toMatchObject({ state: "running", machineID: MACHINE, sessionID: "ses_1", name: "api" })
    expect(w.ops()).toEqual(["prepare", "start"])
    expect(w.nodeCalls[0]).toMatchObject({ op: "prepare", runtime: { kind: "openshell", profile: "net-off" }, harness: "opencode" })
    expect(w.mints).toEqual([{ machineID: MACHINE, launchID: launch.id }])
    expect(w.nodeCalls[1]).toEqual({
      op: "start",
      launchID: launch.id,
      workspace: sandboxWorkspace,
      harness: "opencode",
      hub: { url: HUB_URL, token: "hlt1.token-1" },
    })
    expect(w.spokeCalls).toEqual([
      { connID: "conn-launch-1", req: { op: "create", directory: "/sandbox/work", title: "api", launchID: launch.id, agent: "build" } },
    ])
    expect(w.primeOrder).toEqual(["role:reviewer", "name:api", "prime:ses_1", "prompt:ses_1"])
    expect(w.changes.map((l) => l.state)).toEqual(["queued", "provisioning", "running"])
    w.engine.shutdown()
  })

  test("a token the hub will not mint fails the launch before start; the fresh workspace is removed", async () => {
    const w = world()
    w.tokens.refuse = true
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    expect(launch).toMatchObject({ state: "ended", outcome: "failed" })
    expect(launch.reason).toContain("token")
    expect(w.ops()).toEqual(["prepare", "cleanup"])
    expect(w.nodeCalls[1]).toMatchObject({ op: "cleanup", policy: "remove", workspace: sandboxWorkspace })
    w.engine.shutdown()
  })
})

describe("waiting for the sandbox's spoke", () => {
  test("a harness that connects later (within LAUNCH_CONNECT_MS) is waited for", async () => {
    const w = world()
    w.control.connectOnStart = false
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    expect(launch.state).toBe("provisioning")
    await w.clock.advance(LAUNCH_CONNECT_MS - 1_000)
    expect((await w.launch(launch.id))!.state).toBe("provisioning")
    w.connectLaunch(launch.id)
    await settle()
    expect(await w.launch(launch.id)).toMatchObject({ state: "running", sessionID: "ses_1" })
    w.engine.shutdown()
  })

  test("no launch-bound connection within LAUNCH_CONNECT_MS fails the launch; the harness is stopped, the workspace removed", async () => {
    const w = world()
    w.control.connectOnStart = false
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    await w.clock.advance(LAUNCH_CONNECT_MS + 1)
    const ended = (await w.launch(launch.id))!
    expect(ended).toMatchObject({ state: "ended", outcome: "failed" })
    expect(ended.reason).toContain("did not connect")
    expect(w.ops()).toEqual(["prepare", "start", "stop", "cleanup"])
    expect(w.nodeCalls[2]).toEqual({ op: "stop", launchID: launch.id, workspace: sandboxWorkspace, mode: "kill" })
    expect(w.nodeCalls[3]).toMatchObject({ op: "cleanup", policy: "remove", workspace: sandboxWorkspace })
    expect(w.spokeCalls).toEqual([])
    w.engine.shutdown()
  })

  test("a stop while waiting ends the launch stopped at once; the harness is stopped and the workspace removed", async () => {
    const w = world()
    w.control.connectOnStart = false
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    expect(await w.engine.stop(U, launch.id)).toMatchObject({ state: "ended", outcome: "stopped" })
    expect(w.ops()).toEqual(["prepare", "start", "cancel", "stop", "cleanup"])
    expect(w.nodeCalls.find((r) => r.op === "cleanup")).toMatchObject({ policy: "remove" })
    w.connectLaunch(launch.id)
    await settle()
    expect(w.spokeCalls).toEqual([])
    w.engine.shutdown()
  })
})

describe("openshell stop during start", () => {
  test("a stop arriving while the node starts the harness does not wait for its connection", async () => {
    const w = world()
    w.control.connectOnStart = false
    const hold = deferred<unknown>()
    w.nodeHolds.set("start", hold)
    w.connectNode()
    await w.engine.start()
    const launch = await launched(w)
    const stopping = w.engine.stop(U, launch.id)
    await settle()
    hold.resolve({ started: true })
    expect(await stopping).toMatchObject({ state: "ended", outcome: "stopped" })
    expect(w.ops()).toEqual(["prepare", "start", "cancel", "stop", "cleanup"])
    w.engine.shutdown()
  })
})

/** A running openshell launch on a fresh world. */
async function running(extra: Record<string, unknown> = {}) {
  const w = world()
  w.connectNode()
  await w.engine.start()
  const launch = await launched(w, extra)
  expect(launch.state).toBe("running")
  return { w, launch, sessionID: launch.sessionID! }
}

describe("openshell end", () => {
  test("idle: the harness is stopped gracefully, then artifacts collected and the workspace cleaned up", async () => {
    const { w, launch, sessionID } = await running()
    w.setSession(sessionID, { state: "working", idle: false })
    await settle()
    w.setSession(sessionID, { state: "idle", idle: true })
    await w.clock.advance(31_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "idle", artifacts: { commits: 2 } })
    expect(w.nodeCalls.slice(2).map((r) => [r.op, (r as any).mode ?? (r as any).policy])).toEqual([
      ["stop", "graceful"],
      ["collect", undefined],
      ["cleanup", "keep"],
    ])
    w.engine.shutdown()
  })

  test("DELETE: the session is stopped, then the harness killed, artifacts collected, the workspace cleaned up", async () => {
    const { w, launch, sessionID } = await running({ end: { cleanup: "remove" } })
    expect(await w.engine.stop(U, launch.id)).toMatchObject({ state: "ended", outcome: "stopped" })
    expect(w.stops).toEqual([sessionID])
    expect(w.nodeCalls.slice(2).map((r) => [r.op, (r as any).mode ?? (r as any).policy])).toEqual([
      ["stop", "kill"],
      ["collect", undefined],
      ["cleanup", "remove"],
    ])
    w.engine.shutdown()
  })

  test("a short gap of the sandbox's spoke (gateway restart, policy change) is not lost; 10 minutes is", async () => {
    const { w, launch, sessionID } = await running({ end: { when: "never" } })
    w.dropLaunch(launch.id)
    w.dropSession(sessionID)
    await w.clock.advance(9 * 60_000)
    w.connectLaunch(launch.id)
    w.setSession(sessionID, { state: "idle", idle: true })
    await w.clock.advance(60_000)
    expect((await w.launch(launch.id))!.state).toBe("running")
    w.dropLaunch(launch.id)
    w.dropSession(sessionID)
    await w.clock.advance(10 * 60_000 + 1_000)
    expect(await w.launch(launch.id)).toMatchObject({ state: "ended", outcome: "lost" })
    expect(w.nodeCalls.find((r) => r.op === "stop")).toMatchObject({ mode: "kill" })
    w.engine.shutdown()
  })
})
