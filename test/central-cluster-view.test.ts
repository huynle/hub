// ClusterView (design §9, decision vkxkqiuf §5): every pod publishes its Registry and NodeRegistry slices per tenant
// to the Catalog (hash of the user, session "_view", one report per pod, with a TTL) and as deltas on the Bus;
// every pod mirrors the others' slices, rebuilt from the Catalog at start and on resync. A pod that stops removes
// its slices; a pod that dies stops refreshing them and they expire.
import { afterEach, describe, expect, test } from "bun:test"
import { MemoryBus } from "../src/central/backend/memory-bus"
import { MemoryCatalog } from "../src/central/backend/memory-catalog"
import type { Bus, Catalog } from "../src/central/backend/types"
import { ClusterView, VIEW_SESSION, VIEW_TOPIC } from "../src/central/cluster/view"
import { NodeRegistry } from "../src/central/nodes"
import { Registry } from "../src/central/registry"
import { NODE_ROLE, PROTOCOL_VERSION, type Hello, type NodeHello } from "../src/protocol"
import { waitFor } from "./central-harness"

const owners: Record<string, string> = { mch_a: "alice", mch_n: "alice", mch_bob: "bob" }
const ownerOf = (machineID: string) => owners[machineID]
const hello = (processID: string): Hello => ({ t: "hello", v: 1, processID, kind: "standalone", directory: "/work", pid: 1, mode: "always", opencodeVersion: "2", pluginVersion: "0" })
const nodeHello: NodeHello = {
  t: "hello",
  v: PROTOCOL_VERSION,
  role: NODE_ROLE,
  instanceID: "inst_1",
  nodeVersion: "1.0.0",
  runtimes: [{ kind: "host", harnesses: ["opencode"] }],
  labels: {},
  capacity: { slots: 2 },
  used: { slots: 0 },
  workspaceRoots: ["/w"],
  draining: false,
  launches: [],
}

const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

const TIMING = { heartbeatMs: 40, ttlMs: 120, publishDelayMs: 0 }

function pod(podID: string, shared: { catalog: Catalog; bus: Bus }) {
  const registry = new Registry(Date.now, undefined, ownerOf)
  const nodes = new NodeRegistry(ownerOf)
  const view = new ClusterView({ ...shared, podID, registry, nodes, users: () => ["alice", "bob"], ...TIMING })
  stops.push(() => view.stop())
  return { registry, nodes, view }
}

const shared = () => ({ catalog: new MemoryCatalog(), bus: new MemoryBus() })

describe("ClusterView", () => {
  test("a connection on A appears on B and goes away with it", async () => {
    const backends = shared()
    const a = pod("pod-a", backends)
    const b = pod("pod-b", backends)
    await Promise.all([a.view.start(), b.view.start()])
    a.registry.connect("c1", { id: "mch_a", name: "laptop" }, hello("p1"))
    a.registry.setSessions("c1", [{ id: "ses_1", title: "t", directory: "/work", updated: 1, owned: true }])
    await waitFor(() => b.registry.owner("ses_1") === "c1")
    expect(b.registry.sessionTenant("ses_1")).toBe("alice")
    expect((await backends.catalog.entries("alice")).map((e) => [e.sessionID, e.connID])).toEqual([[VIEW_SESSION, "pod-a"]])
    a.registry.disconnect("c1")
    await waitFor(() => !b.registry.hasSession("ses_1"))
  })

  test("nodes on A are placement candidates on B", async () => {
    const backends = shared()
    const a = pod("pod-a", backends)
    const b = pod("pod-b", backends)
    await Promise.all([a.view.start(), b.view.start()])
    a.nodes.connect("n1", { id: "mch_n", name: "box" }, nodeHello)
    await waitFor(() => b.nodes.list("alice").length === 1)
    expect(b.nodes.forMachine("mch_n")?.connID).toBe("n1")
  })

  test("a pod that starts later rebuilds the others' state from the Catalog", async () => {
    const backends = shared()
    const a = pod("pod-a", backends)
    await a.view.start()
    a.registry.connect("c1", { id: "mch_a", name: "laptop" }, hello("p1"))
    a.registry.connect("cbob", { id: "mch_bob", name: "bob" }, hello("p2"))
    await waitFor(() => a.view.published() === 2)
    const b = pod("pod-b", backends)
    await b.view.start()
    expect(b.registry.connTenant("c1")).toBe("alice")
    expect(b.registry.connTenant("cbob")).toBe("bob")
  })

  test("a pod that stops removes its slices", async () => {
    const backends = shared()
    const a = pod("pod-a", backends)
    const b = pod("pod-b", backends)
    await Promise.all([a.view.start(), b.view.start()])
    a.registry.connect("c1", { id: "mch_a", name: "laptop" }, hello("p1"))
    await waitFor(() => b.registry.connTenant("c1") === "alice")
    await a.view.stop()
    await waitFor(() => b.registry.connTenant("c1") === undefined)
    expect(await backends.catalog.entries("alice")).toEqual([])
  })

  test("a dead pod's slices expire on the other pods and in the Catalog", async () => {
    const backends = shared()
    const b = pod("pod-b", backends)
    await b.view.start()
    const slice = { registry: { conns: [{ id: "c_dead", machine: { id: "mch_a", name: "x" }, hello: hello("p9"), connected: 1, seq: 1, lastSeen: 1, sessions: [], activity: [] }], boards: [], permissions: [], forms: [], presence: [], busy: [] } }
    await backends.catalog.set("alice", VIEW_SESSION, "pod-dead", slice, { ttlMs: TIMING.ttlMs })
    await backends.bus.publish(VIEW_TOPIC, { pod: "pod-dead", user: "alice", slice })
    await waitFor(() => b.registry.connTenant("c_dead") === "alice")
    await waitFor(() => b.registry.connTenant("c_dead") === undefined, 1000)
    const late = pod("pod-c", backends)
    await late.view.start()
    expect(late.registry.connTenant("c_dead")).toBeUndefined()
  })

  test("resync replaces the mirror with the Catalog's state", async () => {
    const backends = shared()
    const b = pod("pod-b", backends)
    await b.view.start()
    const slice = { registry: { conns: [{ id: "c_x", machine: { id: "mch_a", name: "x" }, hello: hello("p9"), connected: 1, seq: 1, lastSeen: 1, sessions: [], activity: [] }], boards: [], permissions: [], forms: [], presence: [], busy: [] } }
    // Written without a Bus message (lost): only a resync finds it.
    await backends.catalog.set("alice", VIEW_SESSION, "pod-x", slice, { ttlMs: 60_000 })
    expect(b.registry.connTenant("c_x")).toBeUndefined()
    await b.view.resync()
    expect(b.registry.connTenant("c_x")).toBe("alice")
    await backends.catalog.delete("alice", VIEW_SESSION, "pod-x")
    await b.view.resync()
    expect(b.registry.connTenant("c_x")).toBeUndefined()
  })
})
