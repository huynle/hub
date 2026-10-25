// The hello a non-OpenCode spoke sends: its harness, version and evidence, and every core op (CORE_OPS) and optional
// feature it serves announced (a non-OpenCode hello implies none, P7-T1).
import { describe, expect, test } from "bun:test"
import { CORE_OPS, encode, helloHarness, parseSpokeMessage, PROTOCOL_VERSION, spokeFeatures, type Hello } from "../../protocol/src/index.ts"
import { buildHarnessHello, type HarnessHelloOptions } from "../src/index.ts"

const BASE: HarnessHelloOptions = {
  harness: "claude-code",
  harnessVersion: "2.1.296",
  evidence: "hooks",
  pluginVersion: "0.6.1",
  directory: "/work/repo",
  ops: ["permission", "stop"],
}

const parse = (hello: Omit<Hello, "t" | "v">) => parseSpokeMessage(encode({ t: "hello", v: PROTOCOL_VERSION, ...hello } as Hello)) as Hello | undefined

describe("buildHarnessHello", () => {
  test("carries harness, version and evidence, and parses as a hello", () => {
    const hello = buildHarnessHello(BASE)
    expect(hello.harness).toBe("claude-code")
    expect(hello.harnessVersion).toBe("2.1.296")
    expect(hello.evidence).toBe("hooks")
    expect(hello.pluginVersion).toBe("0.6.1")
    expect(hello.directory).toBe("/work/repo")
    const parsed = parse(hello)
    expect(parsed).toBeDefined()
    expect(helloHarness(parsed!)).toEqual({ harness: "claude-code", harnessVersion: "2.1.296", evidence: "hooks" })
  })

  test("sends an empty opencodeVersion so hubs that predate `harness` accept it", () => {
    expect(buildHarnessHello(BASE).opencodeVersion).toBe("")
  })

  test("announces exactly the core ops it serves, in CORE_OPS order, then its features", () => {
    const hello = buildHarnessHello({ ...BASE, ops: ["stop", "permission", "stop"], features: ["deliver", "sessionTokens", "deliver"] })
    expect(hello.features).toEqual(["stop", "permission", "deliver", "sessionTokens"].sort((a, b) => order(a) - order(b)))
    expect(hello.features).toEqual(["stop", "permission", "deliver", "sessionTokens"])
    const served = spokeFeatures(parse(hello)!)
    expect(served.has("permission")).toBe(true)
    expect(served.has("turn")).toBe(false)
    expect(served.has("steer")).toBe(false)
    expect(served.has("timeline")).toBe(false)
  })

  test("a core op subset only: no op means no core op announced", () => {
    const hello = buildHarnessHello({ ...BASE, ops: [] })
    for (const op of CORE_OPS) expect(spokeFeatures(parse(hello)!).has(op)).toBe(false)
  })

  test("defaults: service kind, always mode, this process's pid, a generated process ID", () => {
    const a = buildHarnessHello(BASE)
    expect(a.kind).toBe("service")
    expect(a.mode).toBe("always")
    expect(a.pid).toBe(process.pid)
    expect(a.processID).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(buildHarnessHello(BASE).processID).not.toBe(a.processID)
    const b = buildHarnessHello({ ...BASE, processID: "cc_1", kind: "standalone", mode: "session", pid: 7, launchID: "lch_1" })
    expect([b.processID, b.kind, b.mode, b.pid, b.launchID]).toEqual(["cc_1", "standalone", "session", 7, "lch_1"])
    expect(parse(b)).toBeDefined()
  })

  test("refuses OpenCode and malformed harness names", () => {
    expect(() => buildHarnessHello({ ...BASE, harness: "opencode" })).toThrow(/opencode/i)
    for (const harness of ["", "Claude", "a b", "-x", "x".repeat(65)]) expect(() => buildHarnessHello({ ...BASE, harness })).toThrow(/harness/)
  })

  test("refuses an unknown evidence level, op or feature", () => {
    expect(() => buildHarnessHello({ ...BASE, evidence: "guess" as never })).toThrow(/evidence/)
    expect(() => buildHarnessHello({ ...BASE, ops: ["dance" as never] })).toThrow(/core op/)
    expect(() => buildHarnessHello({ ...BASE, features: ["teleport" as never] })).toThrow(/feature/)
    // Core ops go in `ops`, not `features`.
    expect(() => buildHarnessHello({ ...BASE, features: ["turn" as never] })).toThrow(/ops/)
  })

  test("hubPrompt needs deliver", () => {
    expect(() => buildHarnessHello({ ...BASE, features: ["hubPrompt"] })).toThrow(/deliver/)
    expect(buildHarnessHello({ ...BASE, features: ["deliver", "hubPrompt"] }).features).toContain("hubPrompt")
  })

  test("refuses an over-long harness version", () => {
    expect(() => buildHarnessHello({ ...BASE, harnessVersion: "1".repeat(101) })).toThrow(/version/)
  })
})

function order(f: string): number {
  const core = (CORE_OPS as readonly string[]).indexOf(f)
  return core >= 0 ? core : 100 + ["deliver", "sessionTokens"].indexOf(f)
}
