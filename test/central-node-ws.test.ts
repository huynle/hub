// `hub node` connections on /spoke/ws (design §6.3): a node hello (role "node") goes to the NodeRegistry, never to
// the spoke Registry; the hub sends node ops with timeouts and checks every result; revoke closes nodes too.
import { afterEach, describe, expect, test } from "bun:test"
import type { NodeEvent } from "../src/central/nodes"
import { NodeError, RequestTimeoutError, SpokeError } from "../src/central/spoke-ws"
import { HUB_FEATURES, NODE_ROLE, PROTOCOL_VERSION, type NodeHello } from "../src/protocol"
import { connect, harness, PUBLIC, spoke, waitFor, type Harness } from "./central-harness"

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const nodeHello = (extra: Partial<NodeHello> = {}): NodeHello => ({
  t: "hello",
  v: PROTOCOL_VERSION,
  role: NODE_ROLE,
  instanceID: "inst_1",
  nodeVersion: "1.0.0",
  runtimes: [{ kind: "host", harnesses: ["opencode"] }],
  labels: { os: "darwin" },
  capacity: { slots: 4 },
  used: { slots: 0 },
  workspaceRoots: ["/Users/u/projects"],
  draining: false,
  launches: [],
  ...extra,
})

const prepared = { repo: "/Users/u/projects/a", directory: "/Users/u/projects/a/.worktrees/x", mode: "worktree", branch: "x", reused: false } as const
const prepareReq = { op: "prepare", launchID: "lch_1", runtime: { kind: "host" }, harness: "opencode", workspace: { repo: "/Users/u/projects/a", mode: "worktree", branch: "x" } } as const

async function node(central: Harness, options: { token?: string; hello?: Partial<NodeHello> } = {}) {
  const token = options.token ?? (await central.store.addMachine("mbp")).token
  const client = await connect(central, token)
  client.send({ ...nodeHello(options.hello) })
  const welcome = await client.next((f) => f.t === "welcome" || f.t === "bye")
  return Object.assign(client, { token, welcome, machineID: (await central.store.findMachine(token))!.id })
}

/** Answers the hub's node requests with `reply(req)` (a frame body), or leaves them pending when it returns undefined. */
function serve(client: Awaited<ReturnType<typeof node>>, reply: (req: any) => Record<string, unknown> | undefined) {
  const seen: any[] = []
  client.ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    if (frame.t !== "req") return
    seen.push(frame.req)
    const body = reply(frame.req)
    if (body) client.send({ t: "res", id: frame.id, ...body } as any)
  })
  return seen
}

describe("node hello", () => {
  test("the hub announces nodes", () => {
    expect(HUB_FEATURES as readonly string[]).toContain("nodes")
  })

  test("a node gets a welcome with the nodes feature and is a node, never a process or an online machine", async () => {
    h = await harness()
    const client = await node(h)
    expect(client.welcome).toEqual({ t: "welcome", v: PROTOCOL_VERSION, machineID: client.machineID, publicURL: PUBLIC, features: [...HUB_FEATURES] })
    expect(client.welcome.features).toContain("nodes")
    await waitFor(() => h.nodes.count() === 1)
    expect(h.registry.connections()).toBe(0)
    expect(h.registry.catalog()).toEqual([])
    expect(h.nodes.forMachine(client.machineID)).toMatchObject({ machineName: "mbp", labels: { os: "darwin" }, free: { slots: 4 } })
    const health = (await (await h.api("/healthz")).json()) as any
    expect(health).toMatchObject({ ok: true, spokes: 0, nodes: 1 })
    const machines = (await (await h.api("/api/machines")).json()) as any
    expect(machines.machines.find((m: any) => m.id === client.machineID)).toMatchObject({ online: false })
  })

  test("an invalid node hello is a protocol error; the wrong version gets the version bye", async () => {
    h = await harness()
    const token = (await h.store.addMachine("mbp")).token
    const bad = await connect(h, token)
    bad.send({ ...nodeHello(), capacity: undefined } as any)
    expect((await bad.next((f) => f.t === "bye")).reason).toBe("protocol error")
    await bad.closed
    const old = await connect(h, token)
    old.send({ ...nodeHello({ v: PROTOCOL_VERSION + 1 }) })
    expect((await old.next((f) => f.t === "bye")).reason).toContain("version")
    await old.closed
    expect(h.nodes.count()).toBe(0)
  })

  test("capacity and progress frames reach the NodeRegistry; spoke frames from a node are a protocol error", async () => {
    h = await harness()
    const events: NodeEvent[] = []
    h.nodes.subscribe((e) => events.push(e))
    const client = await node(h)
    client.send({ t: "capacity", capacity: { slots: 4 }, used: { slots: 3 }, draining: true })
    client.send({ t: "progress", launchID: "lch_1", phase: "preparing", message: "cloning" })
    await waitFor(() => events.some((e) => e.type === "progress"))
    expect(h.nodes.forMachine(client.machineID)).toMatchObject({ free: { slots: 1 }, draining: true, launches: [{ launchID: "lch_1", phase: "preparing" }] })
    client.send({ t: "sessions", sessions: [] })
    expect((await client.next((f) => f.t === "bye")).reason).toBe("protocol error")
    await client.closed
    await waitFor(() => h.nodes.count() === 0)
    expect(events.map((e) => e.type)).toEqual(["connected", "capacity", "progress", "disconnected"])
  })

  test("a second node of the same machine is turned away; the same instance reconnecting replaces the old connection", async () => {
    h = await harness()
    const first = await node(h)
    const second = await node(h, { token: first.token, hello: { instanceID: "inst_2" } })
    expect(second.welcome).toEqual({ t: "bye", reason: expect.stringContaining("another node") })
    await second.closed
    expect(h.nodes.count()).toBe(1)
    const again = await node(h, { token: first.token })
    expect(again.welcome.t).toBe("welcome")
    expect((await first.next((f) => f.t === "bye")).reason).toContain("replaced")
    await first.closed
    await waitFor(() => h.nodes.count() === 1)
  })

  test("a spoke and a node of one machine coexist", async () => {
    h = await harness()
    const client = await node(h)
    await spoke(h, { machine: { token: client.token } })
    await waitFor(() => h.registry.connections() === 1 && h.nodes.count() === 1)
    const health = (await (await h.api("/healthz")).json()) as any
    expect(health).toMatchObject({ spokes: 1, nodes: 1 })
  })
})

describe("node requests", () => {
  test("requestNode sends the op and resolves with a checked result", async () => {
    h = await harness()
    const client = await node(h)
    const seen = serve(client, () => ({ ok: true, result: { workspace: prepared } }))
    const connID = h.nodes.forMachine(client.machineID)!.connID
    expect(await h.spokes.requestNode(connID, prepareReq)).toEqual({ workspace: prepared })
    expect(seen).toEqual([prepareReq])
  })

  test("an error answer, an invalid result and a disconnect reject with NodeError", async () => {
    h = await harness()
    const client = await node(h)
    const connID = h.nodes.forMachine(client.machineID)!.connID
    serve(client, (req) =>
      req.op === "cancel" ? { ok: false, error: "nothing to cancel" } : req.op === "collect" ? { ok: true, result: { artifacts: { commits: -1 } } } : undefined,
    )
    const cancel = h.spokes.requestNode(connID, { op: "cancel", launchID: "lch_1" })
    await expect(cancel).rejects.toBeInstanceOf(NodeError)
    await expect(cancel).rejects.toThrow("nothing to cancel")
    const collect = h.spokes.requestNode(connID, { op: "collect", launchID: "lch_1", workspace: prepared })
    await expect(collect).rejects.toBeInstanceOf(NodeError)
    await expect(collect).rejects.toThrow("commits")
    const pending = h.spokes.requestNode(connID, prepareReq)
    client.close()
    await expect(pending).rejects.toBeInstanceOf(NodeError)
    await expect(h.spokes.requestNode(connID, prepareReq)).rejects.toBeInstanceOf(NodeError)
  })

  test("each node op has its own timeout", async () => {
    h = await harness({ timing: { nodeTimeoutsMs: { cancel: 50 } } })
    const client = await node(h)
    serve(client, () => undefined)
    const connID = h.nodes.forMachine(client.machineID)!.connID
    const started = Date.now()
    const cancel = h.spokes.requestNode(connID, { op: "cancel", launchID: "lch_1" })
    await expect(cancel).rejects.toBeInstanceOf(RequestTimeoutError)
    await expect(cancel).rejects.toThrow("node")
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("spoke requests never go to a node, and node requests never go to a spoke", async () => {
    h = await harness()
    const client = await node(h)
    const nodeConn = h.nodes.forMachine(client.machineID)!.connID
    await expect(h.spokes.request(nodeConn, { op: "status" } as any)).rejects.toBeInstanceOf(SpokeError)
    const other = await spoke(h)
    await waitFor(() => h.registry.connections() === 1)
    const spokeConn = h.registry.connectionsFor((await h.store.findMachine(other.token))!.id)[0]!
    await expect(h.spokes.requestNode(spokeConn, prepareReq)).rejects.toBeInstanceOf(NodeError)
  })
})

describe("node revoke", () => {
  test("revoking the machine closes its node with bye revoked", async () => {
    h = await harness()
    const client = await node(h)
    await waitFor(() => h.nodes.count() === 1)
    expect((await h.api(`/api/machines/${client.machineID}`, { method: "DELETE" })).status).toBe(204)
    expect((await client.next((f) => f.t === "bye")).reason).toBe("revoked")
    await client.closed
    await waitFor(() => h.nodes.count() === 0)
  })
})
