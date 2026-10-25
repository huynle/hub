// Phase 5 (OpenShell sandboxes) protocol: a prepared workspace names its runtime (and sandbox), so collect,
// cleanup, start and stop reach the right runtime without node state; the hub starts and stops a launch's harness
// through the node (start/stop ops, node feature "sandbox"); a spoke started inside a sandbox says which launch it
// belongs to (hello launchID). Older peers keep parsing what they parsed before.
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"

const P = protocol as any
const j = (v: unknown) => JSON.stringify(v)

const prepared = { repo: "/Users/huy/projects/hub", directory: "/Users/huy/projects/hub/.worktrees/feat-x", mode: "worktree", branch: "feat/x", base: "main", head: "0123abcd", reused: false }
const sandboxed = { ...prepared, mode: "clone", directory: "/sandbox/work", runtime: { kind: "openshell", sandbox: "hub-0123456789abcdef0123", profile: "untrusted-code" } }

const fromHub = (m: unknown) => P.parseNodeServerMessage(j(m))
const req = (r: unknown) => fromHub({ t: "req", id: "n1", req: r })

describe("prepared workspace runtime", () => {
  test("a prepared workspace without runtime is a host workspace (phase 4 shape still parses)", () => {
    expect(P.preparedWorkspaceProblem(prepared)).toBeUndefined()
    expect(P.preparedWorkspaceRuntime(prepared)).toEqual({ kind: "host" })
  })

  test("runtime names a known kind, optionally a sandbox and a profile", () => {
    expect(P.preparedWorkspaceProblem(sandboxed)).toBeUndefined()
    expect(P.preparedWorkspaceRuntime(sandboxed)).toEqual(sandboxed.runtime)
    expect(P.preparedWorkspaceProblem({ ...prepared, runtime: { kind: "host" } })).toBeUndefined()
    expect(P.preparedWorkspaceProblem({ ...prepared, runtime: { kind: "openshell" } })).toBeUndefined()
    for (const runtime of ["host", null, {}, { kind: "vm" }, { kind: "openshell", profile: "Bad Profile" }]) {
      expect(P.preparedWorkspaceProblem({ ...prepared, runtime })).toMatch(/runtime/)
    }
  })

  test("the sandbox name is a lowercase DNS label, and only an openshell workspace has one", () => {
    for (const sandbox of ["a", "hub-1", "x".repeat(63), "0abc"]) expect(P.isSandboxName(sandbox)).toBe(true)
    for (const sandbox of ["", "-a", "a-", "A", "a_b", "a.b", "x".repeat(64), "a b", "demo\n", 5]) {
      expect(P.isSandboxName(sandbox)).toBe(false)
      expect(P.preparedWorkspaceProblem({ ...sandboxed, runtime: { kind: "openshell", sandbox } })).toMatch(/sandbox/)
    }
    expect(P.preparedWorkspaceProblem({ ...prepared, runtime: { kind: "host", sandbox: "hub-1" } })).toMatch(/sandbox/)
  })

  test("collect and cleanup carry a sandboxed workspace; prepare may return one", () => {
    expect(req({ op: "collect", launchID: "lch_1", workspace: sandboxed })).toBeDefined()
    expect(req({ op: "cleanup", launchID: "lch_1", workspace: sandboxed, policy: "remove" })).toBeDefined()
    expect(req({ op: "collect", launchID: "lch_1", workspace: { ...sandboxed, runtime: { kind: "openshell", sandbox: "Demo" } } })).toBeUndefined()
    expect(P.nodeResultProblem("prepare", { workspace: sandboxed })).toBeUndefined()
    expect(P.nodeResultProblem("prepare", { workspace: { ...sandboxed, runtime: { kind: "k8s" } } })).toMatch(/runtime/)
  })
})

const start = {
  op: "start",
  launchID: "lch_1",
  workspace: sandboxed,
  harness: "opencode",
  hub: { url: "https://hub.example", token: "hlt1.eyJsaWQiOiJsY2hfMSJ9.c2ln" },
  env: { OPENCODE_DISABLE_AUTOUPDATE: "1", HUB_LAUNCH_ID: "lch_1" },
}

describe("start and stop ops", () => {
  test("start carries the launch, its prepared workspace, the harness, the hub connection and env; it round-trips", () => {
    expect(req(start)).toEqual({ t: "req", id: "n1", req: start })
    const { env: _env, ...bare } = start
    expect(req(bare)).toBeDefined()
    expect(req({ ...start, workspace: prepared })).toBeDefined()
  })

  test("start rejects a bad workspace, harness, hub URL or token", () => {
    expect(req({ ...start, workspace: { ...sandboxed, runtime: { kind: "openshell", sandbox: "-x" } } })).toBeUndefined()
    expect(req({ ...start, harness: "Open Code" })).toBeUndefined()
    expect(req({ ...start, launchID: "a b" })).toBeUndefined()
    for (const hub of [undefined, {}, { url: "ftp://hub", token: "t" }, { url: "https://hub.example" }, { url: "https://hub.example", token: "" }, { url: "https://hub.example", token: "a b" }, { url: "https://hub.example", token: "x".repeat(4097) }]) {
      expect(req({ ...start, hub })).toBeUndefined()
    }
  })

  test("start env: at most 64 upper-case names with short printable values", () => {
    expect(P.START_ENV_MAX).toBe(64)
    expect(req({ ...start, env: {} })).toBeDefined()
    expect(req({ ...start, env: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`V${i}`, "x"])) })).toBeDefined()
    for (const env of [
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, "x"])),
      { lower: "x" },
      { "1ABC": "x" },
      { "A-B": "x" },
      { A: 1 },
      { A: "x".repeat(4097) },
      { A: "a\nb" },
      "A=1",
      ["A"],
    ]) {
      expect(req({ ...start, env })).toBeUndefined()
    }
  })

  test("stop carries the launch, its workspace and optionally graceful or kill", () => {
    const stop = { op: "stop", launchID: "lch_1", workspace: sandboxed }
    expect(req(stop)).toEqual({ t: "req", id: "n1", req: stop })
    expect(req({ ...stop, mode: "graceful" })).toBeDefined()
    expect(req({ ...stop, mode: "kill" })).toBeDefined()
    expect(P.STOP_MODES).toEqual(["graceful", "kill"])
    expect(req({ ...stop, mode: "nuke" })).toBeUndefined()
    expect(req({ ...stop, workspace: undefined })).toBeUndefined()
    expect(req({ op: "stop", workspace: sandboxed })).toBeUndefined()
  })

  test("nodeResultProblem checks start and stop results", () => {
    expect(P.nodeResultProblem("start", { started: true })).toBeUndefined()
    expect(P.nodeResultProblem("start", { started: false, reason: "already running" })).toBeUndefined()
    expect(P.nodeResultProblem("start", {})).toMatch(/started/)
    expect(P.nodeResultProblem("start", { started: true, reason: "x".repeat(501) })).toMatch(/reason/)
    expect(P.nodeResultProblem("stop", { stopped: true })).toBeUndefined()
    expect(P.nodeResultProblem("stop", { stopped: false, reason: "nothing running" })).toBeUndefined()
    expect(P.nodeResultProblem("stop", { stopped: "yes" })).toMatch(/stopped/)
    expect(P.nodeResultProblem("stop", null)).toBeDefined()
  })
})

describe("launch phases and the sandbox feature", () => {
  test("a node reports starting, running, stopping and stopped launches, optionally with their sandbox", () => {
    for (const phase of ["starting", "running", "stopping", "stopped"]) expect(P.NODE_LAUNCH_PHASES).toContain(phase)
    const node = (m: unknown) => P.parseNodeMessage(j(m))
    expect(node({ t: "progress", launchID: "lch_1", phase: "running", message: "sandbox hub-1 ready" })).toBeDefined()
    const hello = {
      t: "hello", v: protocol.PROTOCOL_VERSION, role: "node", instanceID: "node_1", nodeVersion: "0.7.0", runtimes: [], labels: {},
      capacity: { slots: 1 }, used: { slots: 1 }, workspaceRoots: ["/r"], draining: false,
      launches: [{ launchID: "lch_1", phase: "running", directory: "/sandbox/work", sandbox: "hub-0123456789abcdef0123" }],
    }
    expect(node(hello)).toEqual(hello)
    expect(node({ ...hello, launches: [{ launchID: "lch_1", phase: "running", sandbox: "Demo" }] })).toBeUndefined()
  })

  test("sandbox is a known node feature the node can announce (it serves start and stop); nodeFeatures reads a hello", () => {
    expect(P.KNOWN_NODE_FEATURES).toContain("sandbox")
    expect(P.NODE_FEATURES).toContain("sandbox")
    const hello = { features: ["sandbox"] } as any
    expect(P.nodeFeatures(hello).has("sandbox")).toBe(true)
    expect(P.nodeFeatures({} as any).has("sandbox")).toBe(false)
  })

  test("start and stop need the sandbox feature; prepare, collect, cleanup and cancel need none", () => {
    expect(P.nodeRequestFeature({ op: "start" })).toBe("sandbox")
    expect(P.nodeRequestFeature({ op: "stop" })).toBe("sandbox")
    for (const op of ["prepare", "collect", "cleanup", "cancel"]) expect(P.nodeRequestFeature({ op })).toBeUndefined()
  })
})

describe("spoke hello launchID", () => {
  const spokeHello = { t: "hello", v: protocol.PROTOCOL_VERSION, processID: "p1", kind: "service", directory: "/sandbox/work", pid: 42, mode: "always", opencodeVersion: "2.0.25", pluginVersion: "0.1.0", harness: "opencode" }

  test("a spoke started for a launch names it in its hello; a hello without one is unchanged", () => {
    const hello = { ...spokeHello, launchID: "lch_1" }
    expect(protocol.parseSpokeMessage(j(hello))).toEqual(hello as any)
    const typed: protocol.Hello = hello as protocol.Hello
    expect(typed.launchID).toBe("lch_1")
    expect(protocol.parseSpokeMessage(j(spokeHello))).toEqual(spokeHello as any)
  })

  test("launchID is a plain id", () => {
    for (const launchID of ["", "a b", 5, "x".repeat(301), null]) expect(protocol.parseSpokeMessage(j({ ...spokeHello, launchID }))).toBeUndefined()
  })
})
