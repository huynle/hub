// Registry across pods (design §9, decision vkxkqiuf §5): each pod's Registry is the single writer of its own
// connections and exports a per-tenant slice (connections, status boards, pending permissions and forms, presence,
// busy sessions); another pod applies it as a remote slice and answers the same synchronous reads over local and
// remote state. Here two Registries stand for two pods and slices are copied between them as JSON.
import { beforeEach, describe, expect, test } from "bun:test"
import { BusyError, Registry, type RegistryMessage } from "../src/central/registry"
import type { Hello, SessionInfo } from "../src/protocol"

const hello = (processID: string, extra: Partial<Hello> = {}): Hello => ({
  t: "hello",
  v: 1,
  processID,
  kind: "standalone",
  directory: "/work",
  pid: 42,
  mode: "always",
  opencodeVersion: "2.0.0",
  pluginVersion: "0.0.1",
  ...extra,
})

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: `title ${id}`, directory: "/work", updated: 1, owned: false, ...extra })
const ev = (type: string, data: Record<string, unknown>) => ({ type, data })

const owners: Record<string, string> = { mch_a: "alice", mch_b: "alice", mch_bob: "bob" }
const tenantOf = (machineID: string) => owners[machineID]
const laptop = { id: "mch_a", name: "laptop" }
const server = { id: "mch_b", name: "server" }

let clock = 1_000
let a: Registry
let b: Registry
let messagesB: RegistryMessage[]

/** Copies every slice of `from` to `to` as pod `pod` (a JSON round trip, as over the Bus). */
function mirror(from: Registry, to: Registry, pod: string): void {
  for (const tenant of new Set([...from.clusterTenants(), "alice", "bob"])) to.setRemote(pod, tenant, JSON.parse(JSON.stringify(from.clusterSlice(tenant) ?? null)) ?? undefined)
}

beforeEach(() => {
  clock = 1_000
  a = new Registry(() => clock, undefined, tenantOf)
  b = new Registry(() => clock, undefined, tenantOf)
  messagesB = []
  b.subscribe((m) => messagesB.push(m))
})

describe("remote connections", () => {
  test("a spoke on pod A is visible on pod B through the read API", () => {
    a.connect("c1", laptop, hello("p1", { features: ["deliver"] }))
    a.setSessions("c1", [session("ses_1", { owned: true }), session("ses_2")])
    a.connect("c2", server, hello("p2", { kind: "service" }))
    mirror(a, b, "pod-a")

    expect(b.connections()).toBe(0)
    expect(b.connectionsFor("mch_a")).toEqual([])
    expect(b.sessionTenant("ses_1")).toBe("alice")
    expect(b.owns("alice", "ses_1")).toBe(true)
    expect(b.hasSession("ses_2")).toBe(true)
    expect(b.owner("ses_1")).toBe("c1")
    expect(b.sessionTargets("ses_1")).toEqual(["c1"])
    expect(b.connTenant("c1")).toBe("alice")
    expect(b.connMachine("c1")).toBe("mch_a")
    expect(b.machineReports("mch_a", "ses_1")).toBe(true)
    expect(b.machineReports("mch_b", "ses_1")).toBe(false)
    expect(b.serviceFor("mch_b")).toBe("c2")
    expect(b.supports("c1", "deliver")).toBe(true)
    expect(b.supports("c2", "deliver")).toBe(false)
    expect(b.reportedSessions("c1")).toEqual(["ses_1", "ses_2"])
    expect(b.exposed("ses_1")).toBe(true)

    const catalog = b.catalog()
    expect(catalog.map((m) => m.id)).toEqual(["mch_a", "mch_b"])
    expect(catalog[0]!.processes[0]!.sessions.map((s) => s.id)).toEqual(["ses_1", "ses_2"])
    expect(catalog[0]!.processes[0]!.sessions[0]!.status).toEqual([{ id: "ses_1", title: "title ses_1", state: "idle", blockers: [] }])
    expect(b.session("ses_1")).toMatchObject({ id: "ses_1", title: "title ses_1", state: "idle", busy: false })
    expect(messagesB.some((m) => m.type === "catalog")).toBe(true)
  })

  test("launch-bound connections and an absent slice", () => {
    a.connect("c1", laptop, hello("p1", { kind: "service" }), { launchID: "lch_1" })
    mirror(a, b, "pod-a")
    expect(b.launchConn("lch_1")).toBe("c1")
    expect(b.launchOf("c1")).toBe("lch_1")
    expect(b.serviceFor("mch_a")).toBeUndefined()
    b.setRemote("pod-a", "alice", undefined)
    expect(b.launchConn("lch_1")).toBeUndefined()
    expect(b.catalog()).toEqual([])
  })

  test("local connections come first; a dropped pod's sessions are gone", () => {
    b.connect("cb", server, hello("pb"))
    b.setSessions("cb", [session("ses_b")])
    clock += 10
    a.connect("ca", laptop, hello("pa"))
    a.setSessions("ca", [session("ses_a")])
    mirror(a, b, "pod-a")
    expect(b.catalog().map((m) => m.id)).toEqual(["mch_b", "mch_a"])
    expect(b.sessionTenant("ses_a")).toBe("alice")
    b.setRemote("pod-a", "alice", undefined)
    expect(b.hasSession("ses_a")).toBe(false)
    expect(b.hasSession("ses_b")).toBe(true)
  })

  test("another tenant's earlier connection keeps the session (tenancy across pods)", () => {
    a.connect("cbob", { id: "mch_bob", name: "bob" }, hello("pb"))
    a.setSessions("cbob", [session("ses_1")])
    mirror(a, b, "pod-a")
    clock += 10
    b.connect("c1", laptop, hello("p1"))
    b.setSessions("c1", [session("ses_1")])
    expect(b.sessionTenant("ses_1")).toBe("bob")
    expect(b.reportedSessions("c1")).toEqual([])
  })
})

describe("remote state", () => {
  test("status, pending permissions and forms of A are answerable from B", () => {
    a.connect("c1", laptop, hello("p1"))
    a.setSessions("c1", [session("ses_1")])
    a.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    a.observe("c1", ev("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"] }))
    a.observe("c1", ev("form.created", { form: { id: "frm_1", sessionID: "ses_1", fields: [] } }))
    mirror(a, b, "pod-a")

    expect(b.status("ses_1")?.[0]).toMatchObject({ id: "ses_1", state: "blocked" })
    expect(b.rootOf("ses_1")).toBe("ses_1")
    expect(b.running("ses_1")).toBe(true)
    expect(b.permissionTargets("ses_1", "per_1")).toEqual([{ connID: "c1", sessionID: "ses_1" }])
    expect(b.permissionTarget("ses_1", "per_1")).toEqual({ connID: "c1", sessionID: "ses_1" })
    expect(b.permissionRequest("per_1")?.sessionID).toBe("ses_1")
    expect(b.formTargets("ses_1", "frm_1")).toEqual([{ connID: "c1", sessionID: "ses_1" }])
    expect(b.session("ses_1")?.blockers.map((x) => x.id).sort()).toEqual(["frm_1", "per_1"])

    a.observe("c1", ev("permission.replied", { sessionID: "ses_1", requestID: "per_1" }))
    mirror(a, b, "pod-a")
    expect(b.permissionTargets("ses_1", "per_1")).toEqual([])
  })

  test("the activity feed of a remote root", () => {
    a.connect("c1", laptop, hello("p1"))
    a.setSessions("c1", [session("ses_1")])
    a.observe("c1", ev("session.tool.input.started", { sessionID: "ses_1", id: "t1", name: "bash" }))
    mirror(a, b, "pod-a")
    expect(b.activity("ses_1").map((i) => i.id)).toEqual(["t1"])
    expect(b.session("ses_1")?.now).toEqual({ kind: "tool", tool: "bash" })
  })

  test("a turn on A makes the session busy on B (no second turn, not idle)", () => {
    a.connect("c1", laptop, hello("p1"))
    a.setSessions("c1", [session("ses_1")])
    const release = a.beginTurn("ses_1")
    mirror(a, b, "pod-a")
    expect(b.session("ses_1")?.busy).toBe(true)
    expect(b.catalog()[0]!.processes[0]!.sessions[0]!.busy).toBe(true)
    expect(() => b.beginTurn("ses_1")).toThrow(BusyError)
    release()
    mirror(a, b, "pod-a")
    expect(b.session("ses_1")?.busy).toBe(false)
    b.beginTurn("ses_1")()
  })

  test("presence reported on B suppresses push on A", () => {
    a.connect("c1", laptop, hello("p1"))
    a.setSessions("c1", [session("ses_1")])
    mirror(a, b, "pod-a")
    b.setPresence("dev_1", "ses_1", true)
    mirror(b, a, "pod-b")
    expect(a.watched("ses_1")).toBe(true)
    b.setPresence("dev_1", "ses_1", false)
    mirror(b, a, "pod-b")
    expect(a.watched("ses_1")).toBe(false)
  })

  test("idle needs native or hooks evidence of the remote owner", () => {
    a.connect("c1", laptop, hello("p1", { harness: "opencode", harnessVersion: "2", evidence: "native" }))
    a.setSessions("c1", [session("ses_1", { owned: true })])
    mirror(a, b, "pod-a")
    expect(b.idle("ses_1")).toBe(true)
  })
})

describe("local changes", () => {
  test("are announced with their tenant, and slices cover only that tenant's state", () => {
    const changed: Array<string | undefined> = []
    a.onLocalChange((tenant) => changed.push(tenant))
    a.connect("c1", laptop, hello("p1"))
    a.setSessions("c1", [session("ses_1")])
    a.connect("cbob", { id: "mch_bob", name: "bob" }, hello("pb"))
    a.observe("c1", ev("session.execution.started", { sessionID: "ses_1" }))
    a.setPresence("dev_1", "ses_1", true)
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.includes("alice")).toBe(true)
    expect(a.clusterTenants().sort()).toEqual(["alice", "bob"])
    expect(a.clusterSlice("bob")!.conns.map((c) => c.id)).toEqual(["cbob"])
    expect(a.clusterSlice("alice")!.conns.map((c) => c.id)).toEqual(["c1"])
    expect(a.clusterSlice("carol")).toBeUndefined()
  })

  test("remote slices are not re-exported", () => {
    a.connect("c1", laptop, hello("p1"))
    a.setSessions("c1", [session("ses_1")])
    mirror(a, b, "pod-a")
    expect(b.clusterTenants()).toEqual([])
    expect(b.clusterSlice("alice")).toBeUndefined()
  })
})
