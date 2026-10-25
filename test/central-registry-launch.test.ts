// Launch-bound connections in the Registry (phase 5, decision lk6gn3u7 #5/#6): a spoke inside a sandbox connects
// with a launch token and is bound to that launch. It reports sessions like any spoke, but it is never the
// machine's service (serviceFor, and so the launch engine's launchService check), never an exposure target, and
// the registry can say which connection serves a launch.
import { beforeEach, describe, expect, test } from "bun:test"
import { Registry } from "../src/central/registry"
import type { Hello, SessionInfo } from "../src/protocol"

const hello = (processID: string, kind: "service" | "standalone" = "service", extra: Partial<Hello> = {}): Hello => ({
  t: "hello",
  v: 1,
  processID,
  kind,
  directory: "/work",
  pid: 42,
  mode: "always",
  opencodeVersion: "2.0.0",
  pluginVersion: "0.0.1",
  features: ["launch"],
  ...extra,
})

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: `title ${id}`, directory: "/work", updated: 1, owned: false, ...extra })
const laptop = { id: "mch_a", name: "laptop" }

let registry: Registry
beforeEach(() => {
  registry = new Registry(Date.now, undefined, () => "u1")
})

describe("launch-bound connections", () => {
  test("launchOf/launchConn: the launch a connection is bound to, and the connection of a launch", () => {
    registry.connect("host", laptop, hello("p1"))
    registry.connect("box", laptop, hello("p2", "service", { launchID: "lch_1" }), { launchID: "lch_1" })
    expect(registry.launchOf("box")).toBe("lch_1")
    expect(registry.launchOf("host")).toBeUndefined()
    expect(registry.launchOf("nope")).toBeUndefined()
    expect(registry.launchConn("lch_1")).toBe("box")
    expect(registry.launchConn("lch_2")).toBeUndefined()
    registry.disconnect("box")
    expect(registry.launchConn("lch_1")).toBeUndefined()
  })

  test("a hello launchID alone binds nothing (only the token-checked binding counts)", () => {
    registry.connect("host", laptop, hello("p1", "service", { launchID: "lch_1" }))
    expect(registry.launchOf("host")).toBeUndefined()
    expect(registry.launchConn("lch_1")).toBeUndefined()
    expect(registry.serviceFor(laptop.id)).toBe("host")
  })

  test("serviceFor never picks a launch-bound connection, even the most recent service", () => {
    registry.connect("host", laptop, hello("p1"))
    registry.connect("box", laptop, hello("p2"), { launchID: "lch_1" })
    expect(registry.serviceFor(laptop.id)).toBe("host")
    registry.disconnect("host")
    expect(registry.serviceFor(laptop.id)).toBeUndefined()
  })

  test("exposeTarget never picks a launch-bound connection", () => {
    registry.connect("box", laptop, hello("p2"), { launchID: "lch_1" })
    registry.setSessions("box", [session("ses_1")])
    expect(registry.hasSession("ses_1")).toBe(true)
    expect(registry.exposeTarget("ses_1")).toBeUndefined()
    registry.connect("tui", laptop, hello("p3", "standalone"))
    registry.setSessions("tui", [session("ses_1")])
    expect(registry.exposeTarget("ses_1")).toBe("tui")
  })

  test("its sessions are reported like any spoke's (messaging and reading work)", () => {
    registry.connect("box", laptop, hello("p2"), { launchID: "lch_1" })
    registry.setSessions("box", [session("ses_1")])
    expect(registry.reportedSessions("box")).toEqual(["ses_1"])
    expect(registry.connTenant("box")).toBe("u1")
  })
})
