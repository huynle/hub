// Harness-aware Registry (phase 7, decision fx04e42c #1/#3): a machine may run a service spoke per harness (OpenCode,
// Claude Code, Codex). serviceFor picks the one of the asked harness (OpenCode by default), so a Claude Code service
// connection never hides the OpenCode service; harnessOf names a connection's harness.
import { beforeEach, describe, expect, test } from "bun:test"
import { Registry } from "../src/central/registry"
import type { Hello } from "../src/protocol"

const hello = (processID: string, extra: Partial<Hello> = {}): Hello => ({
  t: "hello",
  v: 1,
  processID,
  kind: "service",
  directory: "/work",
  pid: 42,
  mode: "always",
  opencodeVersion: "2.0.0",
  pluginVersion: "0.0.1",
  features: ["launch"],
  ...extra,
})
const claude = (processID: string, extra: Partial<Hello> = {}): Hello =>
  hello(processID, { harness: "claude-code", harnessVersion: "2.1.296", evidence: "hooks", features: ["permission", "launch"], ...extra })

const laptop = { id: "mch_a", name: "laptop" }

let registry: Registry
beforeEach(() => {
  registry = new Registry(Date.now, undefined, () => "u1")
})

describe("serviceFor(machine, harness)", () => {
  test("a Claude Code service connected later never hides the OpenCode service", () => {
    registry.connect("oc", laptop, hello("p1"))
    registry.connect("cc", laptop, claude("p2"))
    expect(registry.serviceFor(laptop.id)).toBe("oc")
    expect(registry.serviceFor(laptop.id, "opencode")).toBe("oc")
    expect(registry.serviceFor(laptop.id, "claude-code")).toBe("cc")
    expect(registry.serviceFor(laptop.id, "codex")).toBeUndefined()
  })

  test("an explicit harness \"opencode\" hello counts as OpenCode", () => {
    registry.connect("oc", laptop, hello("p1", { harness: "opencode", harnessVersion: "2.0.0", evidence: "native" }))
    expect(registry.serviceFor(laptop.id)).toBe("oc")
  })

  test("without an OpenCode service there is none for OpenCode", () => {
    registry.connect("cc", laptop, claude("p2"))
    expect(registry.serviceFor(laptop.id)).toBeUndefined()
  })

  test("serviceHarnesses lists the harnesses with a service connection on the machine", () => {
    expect(registry.serviceHarnesses(laptop.id)).toEqual([])
    registry.connect("oc", laptop, hello("p1"))
    registry.connect("cc", laptop, claude("p2"))
    registry.connect("cc2", laptop, claude("p3"))
    registry.connect("box", laptop, claude("p4", { harness: "codex" }), { launchID: "lch_1" })
    registry.connect("tui", laptop, hello("p5", { kind: "standalone", harness: "codex" }))
    expect([...registry.serviceHarnesses(laptop.id)].sort()).toEqual(["claude-code", "opencode"])
  })

  test("harnessOf names a connection's harness", () => {
    registry.connect("oc", laptop, hello("p1"))
    registry.connect("cc", laptop, claude("p2"))
    expect(registry.harnessOf("oc")).toBe("opencode")
    expect(registry.harnessOf("cc")).toBe("claude-code")
    expect(registry.harnessOf("nope")).toBeUndefined()
  })
})

describe("catalog features (console controls, P7-T10)", () => {
  test("each process lists the features it serves: an OpenCode hello implies the core ops, others only what they announce", () => {
    registry.connect("oc", laptop, hello("p1"))
    registry.connect("cc", laptop, claude("p2", { features: ["permission", "stop"] }))
    const [machine] = registry.catalog()
    const byID = new Map(machine!.processes.map((p) => [p.id, p]))
    const oc = byID.get("p1")!
    const cc = byID.get("p2")!
    for (const op of ["turn", "steer", "interrupt", "stop", "permission", "form"]) expect(oc.features).toContain(op)
    expect(oc.features).toContain("timeline")
    expect([...cc.features].sort()).toEqual(["permission", "stop"])
    expect(cc.harness).toBe("claude-code")
    expect(cc.evidence).toBe("hooks")
  })
})
