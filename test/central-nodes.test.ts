// NodeRegistry (src/central/nodes.ts): the hub's view of connected `hub node` daemons, kept apart from the spoke
// Registry so a node never appears as a process, in the catalog or as an online machine.
import { describe, expect, test } from "bun:test"
import { NodeRegistry, type NodeEvent } from "../src/central/nodes"
import { NODE_ROLE, PROTOCOL_VERSION, type NodeHello } from "../src/protocol"

const nodeHello = (extra: Partial<NodeHello> = {}): NodeHello => ({
  t: "hello",
  v: PROTOCOL_VERSION,
  role: NODE_ROLE,
  instanceID: "inst_1",
  nodeVersion: "1.0.0",
  runtimes: [{ kind: "host", harnesses: ["opencode"] }],
  labels: { os: "darwin" },
  capacity: { slots: 4, memoryMB: 16000 },
  used: { slots: 1, memoryMB: 2000 },
  workspaceRoots: ["/Users/u/projects"],
  draining: false,
  launches: [{ launchID: "lch_1", phase: "prepared", directory: "/Users/u/projects/a" }],
  ...extra,
})

function setup(owners: Record<string, string | undefined> = { m_1: "u_1", m_2: "u_2" }) {
  let clock = 1000
  const nodes = new NodeRegistry((machineID) => owners[machineID], () => clock)
  const events: NodeEvent[] = []
  nodes.subscribe((event) => events.push(event))
  return { nodes, events, owners, tick: (ms: number) => (clock += ms) }
}

describe("NodeRegistry", () => {
  test("connect records the hello per connection, with the live owner and free capacity", () => {
    const { nodes, events } = setup()
    const node = nodes.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    expect(node).toEqual({
      connID: "conn_1",
      machineID: "m_1",
      machineName: "mbp",
      ownerID: "u_1",
      instanceID: "inst_1",
      nodeVersion: "1.0.0",
      features: [],
      runtimes: [{ kind: "host", harnesses: ["opencode"] }],
      labels: { os: "darwin" },
      capacity: { slots: 4, memoryMB: 16000 },
      used: { slots: 1, memoryMB: 2000 },
      free: { slots: 3, memoryMB: 14000 },
      workspaceRoots: ["/Users/u/projects"],
      draining: false,
      launches: [{ launchID: "lch_1", phase: "prepared", directory: "/Users/u/projects/a" }],
      connectedAt: 1000,
      lastSeen: 1000,
    })
    expect(nodes.count()).toBe(1)
    expect(nodes.get("conn_1")).toEqual(node)
    expect(nodes.forMachine("m_1")).toEqual(node)
    expect(events).toEqual([{ type: "connected", node }])
  })

  test("free capacity never goes below zero; memory is left out when the node reports none", () => {
    const { nodes } = setup()
    const node = nodes.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello({ capacity: { slots: 2 }, used: { slots: 5 } }))
    expect(node.free).toEqual({ slots: 0 })
  })

  test("list is per owner, read live; a node whose machine has no owner (revoked) is never listed", () => {
    const { nodes, owners } = setup()
    nodes.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    nodes.connect("conn_2", { id: "m_2", name: "box" }, nodeHello({ instanceID: "inst_2" }))
    expect(nodes.list("u_1").map((n) => n.connID)).toEqual(["conn_1"])
    expect(nodes.list("u_2").map((n) => n.connID)).toEqual(["conn_2"])
    expect(nodes.list().map((n) => n.connID)).toEqual(["conn_1", "conn_2"])
    owners.m_1 = "u_2" // ownership moved (migration)
    expect(nodes.list("u_2").map((n) => n.connID)).toEqual(["conn_1", "conn_2"])
    owners.m_2 = undefined
    expect(nodes.list("u_2").map((n) => n.connID)).toEqual(["conn_1"])
    expect(nodes.list().map((n) => n.connID)).toEqual(["conn_1"])
  })

  test("a capacity frame replaces capacity, use and draining; labels only when given", () => {
    const { nodes, events } = setup()
    nodes.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    nodes.setCapacity("conn_1", { t: "capacity", capacity: { slots: 6 }, used: { slots: 2 }, draining: true })
    let node = nodes.get("conn_1")!
    expect(node).toMatchObject({ capacity: { slots: 6 }, used: { slots: 2 }, free: { slots: 4 }, draining: true, labels: { os: "darwin" } })
    expect(events.at(-1)).toEqual({ type: "capacity", node })
    nodes.setCapacity("conn_1", { t: "capacity", capacity: { slots: 6 }, used: { slots: 2 }, draining: false, labels: { os: "linux" } })
    node = nodes.get("conn_1")!
    expect(node.labels).toEqual({ os: "linux" })
    expect(node.draining).toBe(false)
  })

  test("progress updates the node's launches and is announced; cleaned and cancelled launches are dropped", () => {
    const { nodes, events } = setup()
    nodes.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    nodes.progress("conn_1", { t: "progress", launchID: "lch_2", phase: "preparing", message: "cloning" })
    expect(nodes.get("conn_1")!.launches).toEqual([
      { launchID: "lch_1", phase: "prepared", directory: "/Users/u/projects/a" },
      { launchID: "lch_2", phase: "preparing" },
    ])
    expect(events.at(-1)).toEqual({ type: "progress", node: nodes.get("conn_1")!, launchID: "lch_2", phase: "preparing", message: "cloning" })
    nodes.progress("conn_1", { t: "progress", launchID: "lch_1", phase: "collecting" })
    expect(nodes.get("conn_1")!.launches[0]).toEqual({ launchID: "lch_1", phase: "collecting", directory: "/Users/u/projects/a" })
    nodes.progress("conn_1", { t: "progress", launchID: "lch_1", phase: "cleaned" })
    nodes.progress("conn_1", { t: "progress", launchID: "lch_2", phase: "cancelled" })
    expect(nodes.get("conn_1")!.launches).toEqual([])
    expect(events.filter((e) => e.type === "progress").map((e) => (e as { phase: string }).phase)).toEqual(["preparing", "collecting", "cleaned", "cancelled"])
  })

  test("touch updates lastSeen; disconnect removes the node and announces it", () => {
    const { nodes, events, tick } = setup()
    nodes.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    tick(500)
    nodes.touch("conn_1")
    const node = nodes.get("conn_1")!
    expect(node.lastSeen).toBe(1500)
    nodes.disconnect("conn_1")
    expect(nodes.get("conn_1")).toBeUndefined()
    expect(nodes.forMachine("m_1")).toBeUndefined()
    expect(nodes.count()).toBe(0)
    expect(events.at(-1)).toEqual({ type: "disconnected", node })
  })

  test("calls on unknown connections are ignored", () => {
    const { nodes, events } = setup()
    nodes.setCapacity("nope", { t: "capacity", capacity: { slots: 1 }, used: { slots: 0 }, draining: false })
    nodes.progress("nope", { t: "progress", launchID: "lch_1", phase: "preparing" })
    nodes.touch("nope")
    nodes.disconnect("nope")
    expect(events).toEqual([])
  })

  test("views are copies: changing one does not change the registry", () => {
    const { nodes } = setup()
    const node = nodes.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello()) as any
    node.launches.push({ launchID: "x", phase: "failed" })
    node.labels.os = "hacked"
    expect(nodes.get("conn_1")!.launches).toHaveLength(1)
    expect(nodes.get("conn_1")!.labels).toEqual({ os: "darwin" })
  })

  test("a listener that throws does not stop the others; unsubscribe stops delivery", () => {
    const nodes = new NodeRegistry(() => "u_1")
    const seen: string[] = []
    nodes.subscribe(() => {
      throw new Error("boom")
    })
    nodes.subscribe((e) => seen.push(e.type))
    const unsubscribe = nodes.subscribe((e) => seen.push(`gone ${e.type}`))
    unsubscribe()
    nodes.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    expect(seen).toEqual(["connected"])
  })
})
