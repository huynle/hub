// NodeRegistry across pods (design §9): each pod exports its own nodes per owner; another pod applies them as a
// remote slice, so placement on any pod sees every node of the user (list/get/forMachine), with the owner read
// live. Node events and the connection count stay with the pod holding the socket.
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
  capacity: { slots: 4 },
  used: { slots: 1 },
  workspaceRoots: ["/Users/u/projects"],
  draining: false,
  launches: [],
  ...extra,
})

function pods(owners: Record<string, string | undefined> = { m_1: "u_1", m_2: "u_1", m_3: "u_2" }) {
  const a = new NodeRegistry((id) => owners[id], () => 1000)
  const b = new NodeRegistry((id) => owners[id], () => 2000)
  const eventsB: NodeEvent[] = []
  b.subscribe((event) => eventsB.push(event))
  /** Copies a's slices to b as pod-a (JSON, as over the Bus). */
  const mirror = () => {
    for (const owner of ["u_1", "u_2"]) b.setRemote("pod-a", owner, JSON.parse(JSON.stringify(a.clusterSlice(owner) ?? null)) ?? undefined)
  }
  return { a, b, eventsB, owners, mirror }
}

describe("NodeRegistry across pods", () => {
  test("a node on A is a placement candidate on B", () => {
    const { a, b, eventsB, mirror } = pods()
    a.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    a.connect("conn_3", { id: "m_3", name: "box" }, nodeHello({ instanceID: "inst_3" }))
    mirror()
    expect(b.list("u_1").map((n) => n.connID)).toEqual(["conn_1"])
    expect(b.list().map((n) => n.connID).sort()).toEqual(["conn_1", "conn_3"])
    expect(b.get("conn_1")).toMatchObject({ machineID: "m_1", ownerID: "u_1", free: { slots: 3 } })
    expect(b.forMachine("m_1")?.connID).toBe("conn_1")
    expect(b.count()).toBe(0)
    expect(b.localForMachine("m_1")).toBeUndefined()
    expect(eventsB).toEqual([])
  })

  test("capacity changes and disconnects on A reach B; the owner is read live", () => {
    const { a, b, owners, mirror } = pods()
    a.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    mirror()
    a.setCapacity("conn_1", { t: "capacity", capacity: { slots: 4 }, used: { slots: 4 }, draining: true })
    mirror()
    expect(b.get("conn_1")).toMatchObject({ free: { slots: 0 }, draining: true })
    owners.m_1 = "u_2"
    expect(b.list("u_2").map((n) => n.connID)).toEqual(["conn_1"])
    owners.m_1 = "u_1"
    a.disconnect("conn_1")
    mirror()
    expect(b.list("u_1")).toEqual([])
    expect(b.get("conn_1")).toBeUndefined()
  })

  test("a local node of the machine wins over a remote one", () => {
    const { a, b, mirror } = pods()
    a.connect("conn_old", { id: "m_1", name: "mbp" }, nodeHello())
    mirror()
    b.connect("conn_new", { id: "m_1", name: "mbp" }, nodeHello())
    expect(b.forMachine("m_1")?.connID).toBe("conn_new")
    expect(b.list("u_1").map((n) => n.connID)).toEqual(["conn_new"])
  })

  test("local changes are announced with the owner; remote nodes are not re-exported", () => {
    const { a, b, mirror } = pods()
    const changed: Array<string | undefined> = []
    a.onLocalChange((owner) => changed.push(owner))
    a.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    a.progress("conn_1", { t: "progress", launchID: "lch_1", phase: "preparing" })
    expect(changed).toEqual(["u_1", "u_1"])
    expect(a.clusterTenants()).toEqual(["u_1"])
    expect(a.clusterSlice("u_2")).toBeUndefined()
    mirror()
    expect(b.clusterTenants()).toEqual([])
    b.setRemote("pod-a", "u_1", undefined)
    expect(b.list()).toEqual([])
  })

  test("a subscriber asking for remote events gets other pods' nodes connecting, their launches' progress and leaving", () => {
    const { a, b, mirror } = pods()
    const events: NodeEvent[] = []
    b.subscribe((event) => events.push(event), { remote: true })
    const summary = () => events.splice(0).map((e) => (e.type === "progress" ? `${e.type}:${e.node.connID}:${e.launchID}:${e.phase}` : `${e.type}:${e.node.connID}`))
    a.connect("conn_1", { id: "m_1", name: "mbp" }, nodeHello())
    mirror()
    expect(summary()).toEqual(["connected:conn_1"])
    expect(events).toEqual([])
    a.progress("conn_1", { t: "progress", launchID: "l_1", phase: "preparing" })
    mirror()
    a.progress("conn_1", { t: "progress", launchID: "l_1", phase: "prepared" })
    mirror()
    mirror()
    expect(summary()).toEqual(["progress:conn_1:l_1:preparing", "progress:conn_1:l_1:prepared"])
    a.setCapacity("conn_1", { t: "capacity", capacity: { slots: 4 }, used: { slots: 2 }, draining: false })
    mirror()
    expect(summary()).toEqual(["capacity:conn_1"])
    // A launch the node lets go of leaves its slice: released (cleaned after prepared, cancelled while preparing).
    a.progress("conn_1", { t: "progress", launchID: "l_1", phase: "cleaned" })
    a.progress("conn_1", { t: "progress", launchID: "l_2", phase: "preparing" })
    mirror()
    a.progress("conn_1", { t: "progress", launchID: "l_2", phase: "cancelled" })
    mirror()
    expect(summary()).toEqual(["progress:conn_1:l_1:cleaned", "progress:conn_1:l_2:preparing", "progress:conn_1:l_2:cancelled"])
    a.disconnect("conn_1")
    mirror()
    expect(summary()).toEqual(["disconnected:conn_1"])
  })
})
