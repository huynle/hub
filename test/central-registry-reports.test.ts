// What the registry tells session tokens (P1-T5): the sessions a connection reports for its own tenant, which
// machine a connection is, whether a machine reports a session, and a hook on every sessions frame.
import { beforeEach, describe, expect, test } from "bun:test"
import { Registry } from "../src/central/registry"
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
const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: id, directory: "/work", updated: 1, owned: false, ...extra })

const owners: Record<string, string> = { mch_a: "alice", mch_a2: "alice", mch_b: "bob" }
let registry: Registry

beforeEach(() => {
  registry = new Registry(Date.now, undefined, (machineID) => owners[machineID])
  registry.connect("c_a", { id: "mch_a", name: "a" }, hello("pa"))
  registry.connect("c_b", { id: "mch_b", name: "b" }, hello("pb"))
})

describe("reportedSessions", () => {
  test("the connection's sessions, subagents included", () => {
    registry.setSessions("c_a", [session("ses_1"), session("ses_child", { parentID: "ses_1" })])
    expect(registry.reportedSessions("c_a").sort()).toEqual(["ses_1", "ses_child"])
  })

  test("leaves out a session another tenant owns (its process connected earlier)", () => {
    registry.setSessions("c_b", [session("ses_x"), session("ses_2")])
    registry.setSessions("c_a", [session("ses_x")])
    expect(registry.reportedSessions("c_b")).toEqual(["ses_2"])
    expect(registry.reportedSessions("c_a")).toEqual(["ses_x"])
  })

  test("empty for an unknown connection", () => {
    expect(registry.reportedSessions("c_nope")).toEqual([])
  })
})

describe("connMachine", () => {
  test("the machine of a connection; undefined once it disconnects", () => {
    expect(registry.connMachine("c_a")).toBe("mch_a")
    registry.disconnect("c_a")
    expect(registry.connMachine("c_a")).toBeUndefined()
  })
})

describe("machineReports", () => {
  test("true while a process of the machine reports the session for its tenant", () => {
    registry.setSessions("c_a", [session("ses_1")])
    expect(registry.machineReports("mch_a", "ses_1")).toBe(true)
    expect(registry.machineReports("mch_b", "ses_1")).toBe(false)
    registry.setSessions("c_a", [])
    expect(registry.machineReports("mch_a", "ses_1")).toBe(false)
  })

  test("false for a session another tenant owns, false after disconnect", () => {
    registry.setSessions("c_b", [session("ses_x")])
    registry.setSessions("c_a", [session("ses_x"), session("ses_1")])
    expect(registry.machineReports("mch_b", "ses_x")).toBe(false)
    registry.disconnect("c_a")
    expect(registry.machineReports("mch_a", "ses_1")).toBe(false)
  })

  test("another process of the same machine still reporting it counts", () => {
    registry.connect("c_a_2", { id: "mch_a", name: "a" }, hello("pa2"))
    registry.setSessions("c_a", [session("ses_1")])
    registry.setSessions("c_a_2", [session("ses_1")])
    registry.disconnect("c_a")
    expect(registry.machineReports("mch_a", "ses_1")).toBe(true)
  })
})

describe("onSessions", () => {
  test("called with the connection on every sessions frame, unchanged ones too, until unsubscribed", () => {
    const seen: string[] = []
    const off = registry.onSessions((connID) => seen.push(connID))
    registry.setSessions("c_a", [session("ses_1")])
    registry.setSessions("c_a", [session("ses_1")])
    registry.setSessions("c_b", [])
    registry.setSessions("c_unknown", [])
    off()
    registry.setSessions("c_a", [])
    expect(seen).toEqual(["c_a", "c_a", "c_b"])
  })

  test("the frame is applied before listeners run", () => {
    let during: string[] = []
    registry.onSessions((connID) => (during = registry.reportedSessions(connID)))
    registry.setSessions("c_a", [session("ses_1")])
    expect(during).toEqual(["ses_1"])
  })
})
