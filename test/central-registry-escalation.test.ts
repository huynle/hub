// Registry support for escalations (P3-T8): a pending permission that goes away (replied, dropped, its process gone)
// is announced once with its tenant, so the Decision it escalated closes; an agent's recommendation shows on the
// permission's blocker (catalog, status) until the request goes.
import { beforeEach, describe, expect, test } from "bun:test"
import { Registry, type RegistryMessage } from "../src/central/registry"
import type { Hello, SessionInfo } from "../src/protocol"

const hello = (processID: string): Hello => ({
  t: "hello",
  v: 1,
  processID,
  kind: "standalone",
  directory: "/work",
  pid: 42,
  mode: "always",
  opencodeVersion: "2.0.0",
  pluginVersion: "0.0.1",
})
const session = (id: string): SessionInfo => ({ id, title: `title ${id}`, directory: "/work", updated: 1, owned: false })
const ev = (type: string, data: Record<string, unknown>) => ({ type, data })
const laptop = { id: "mch_a", name: "laptop" }

let registry: Registry
let messages: RegistryMessage[]
let closed: Array<{ requestID: string; sessionID: string; tenant?: string }>

beforeEach(() => {
  registry = new Registry(Date.now, undefined, (machineID) => (machineID === "mch_a" ? "u1" : undefined))
  messages = []
  closed = []
  registry.subscribe((m) => messages.push(m))
  registry.onPermissionClosed((requestID, sessionID, tenant) => closed.push({ requestID, sessionID, ...(tenant !== undefined ? { tenant } : {}) }))
  registry.connect("a", laptop, hello("pa"))
  registry.setSessions("a", [session("ses_1")])
  registry.observe("a", ev("session.created", { sessionID: "ses_sub", parentID: "ses_1", title: "x" }))
})

const ask = (id = "per_1") => registry.observe("a", ev("permission.asked", { sessionID: "ses_sub", id, action: "shell", resources: ["bun test"] }))
const blocker = (id = "per_1") => registry.status("ses_1")!.flatMap((s) => s.blockers).find((b) => b.id === id)

describe("permission closed", () => {
  test("a reply announces it once, with the asking session and its tenant", () => {
    ask()
    registry.observe("a", ev("permission.replied", { sessionID: "ses_sub", requestID: "per_1" }))
    registry.observe("a", ev("permission.replied", { sessionID: "ses_sub", requestID: "per_1" }))
    expect(closed).toEqual([{ requestID: "per_1", sessionID: "ses_sub", tenant: "u1" }])
  })

  test("dropping it (answered elsewhere) and its process disconnecting announce it too", () => {
    ask("per_1")
    ask("per_2")
    registry.dropPermission("per_1")
    registry.disconnect("a")
    expect(closed).toEqual([
      { requestID: "per_1", sessionID: "ses_sub", tenant: "u1" },
      { requestID: "per_2", sessionID: "ses_sub", tenant: "u1" },
    ])
  })

  test("an unknown request's reply announces nothing; a listener can unsubscribe", () => {
    registry.observe("a", ev("permission.replied", { sessionID: "ses_sub", requestID: "per_x" }))
    expect(closed).toEqual([])
    const seen: string[] = []
    const off = registry.onPermissionClosed((id) => seen.push(id))
    off()
    ask()
    registry.dropPermission("per_1")
    expect(seen).toEqual([])
  })

  test("a failing listener does not stop the others or the registry", () => {
    registry.onPermissionClosed(() => {
      throw new Error("broke")
    })
    ask()
    registry.observe("a", ev("permission.replied", { sessionID: "ses_sub", requestID: "per_1" }))
    expect(closed).toHaveLength(1)
    expect(blocker()).toBeUndefined()
  })
})

describe("recommendations on blockers", () => {
  test("recommend: the permission's blocker carries it (status and catalog), with a status message", () => {
    ask()
    messages.length = 0
    expect(registry.recommend("per_1", { by: "@orchestrator", recommends: "approve", why: "only runs tests", decisionID: "dec_1" })).toBe(true)
    expect(blocker()).toMatchObject({ kind: "permission", id: "per_1", recommendation: { by: "@orchestrator", recommends: "approve", why: "only runs tests", decisionID: "dec_1" } })
    const catalogBlocker = registry.catalog()[0]!.processes[0]!.sessions.find((s) => s.id === "ses_1")!.blockers[0]!
    expect(catalogBlocker.recommendation?.by).toBe("@orchestrator")
    const status = messages.filter((m) => m.type === "status")
    expect(status).toHaveLength(1)
    expect(JSON.stringify(status[0])).toContain("only runs tests")
  })

  test("its text is sanitised and bounded", () => {
    ask()
    registry.recommend("per_1", { by: "@orc\u202ehestrator", recommends: "approve", why: `ok\u0007${"x".repeat(2000)}` })
    const rec = blocker()!.recommendation!
    expect(rec.by).toBe("@orchestrator")
    expect(rec.why!.startsWith("okx")).toBe(true)
    expect(rec.why!.length).toBeLessThanOrEqual(1000)
  })

  test("unknown requests take none (false); it goes with the request", () => {
    expect(registry.recommend("per_x", { by: "@o", recommends: "approve" })).toBe(false)
    ask()
    registry.recommend("per_1", { by: "@o", recommends: "approve" })
    registry.observe("a", ev("permission.replied", { sessionID: "ses_sub", requestID: "per_1" }))
    ask()
    expect(blocker()!.recommendation).toBeUndefined()
  })
})
