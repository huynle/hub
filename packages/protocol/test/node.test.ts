// Node protocol (design §6.3): `hub node` connects to /spoke/ws with its machine token and a hello with role
// "node". It reports runtimes, labels, capacity and the launches it carries, sends capacity and progress frames,
// and serves the hub's prepare/collect/cleanup/cancel ops. It has no remote exec channel. A v1 spoke hello is
// unchanged, and an old hub (no "nodes" feature) rejects the node hello, so it never sees node frames.
import { describe, expect, test } from "bun:test"
import * as protocol from "../src/index.ts"
import { encode, HUB_FEATURES, KNOWN_HUB_FEATURES, parseSpokeMessage, PROTOCOL_VERSION } from "../src/index.ts"

const P = protocol as any
const j = (v: unknown) => JSON.stringify(v)

const nodeHello = {
  t: "hello",
  v: PROTOCOL_VERSION,
  role: "node",
  instanceID: "node_01HX",
  nodeVersion: "0.7.0",
  runtimes: [{ kind: "host", harnesses: ["opencode"] }, { kind: "openshell", profiles: ["untrusted-code", "net-off"], backends: ["microvm", "docker"] }],
  labels: { os: "darwin", arch: "arm64", gpu: "no" },
  capacity: { slots: 6, memoryMB: 49152 },
  used: { slots: 2, memoryMB: 9100 },
  workspaceRoots: ["/Users/huy/projects"],
  draining: false,
  launches: [{ launchID: "lch_1", phase: "prepared", directory: "/Users/huy/projects/hub/.worktrees/feat-x" }],
}
const spokeHello = { t: "hello", v: PROTOCOL_VERSION, processID: "p1", kind: "service", directory: "/tmp/x", pid: 42, mode: "always", opencodeVersion: "2.0.25", pluginVersion: "0.1.0" }
const prepared = { repo: "/Users/huy/projects/hub", directory: "/Users/huy/projects/hub/.worktrees/feat-x", mode: "worktree", branch: "feat/x", base: "main", head: "0123abcd", reused: false }

const node = (m: unknown) => P.parseNodeMessage(j(m))
const fromHub = (m: unknown) => P.parseNodeServerMessage(j(m))
const req = (r: unknown) => fromHub({ t: "req", id: "n1", req: r })

describe("node hello", () => {
  test("a node hello round-trips through parseNodeMessage", () => {
    expect(node(nodeHello)).toEqual(nodeHello)
    const typed: protocol.NodeHello = nodeHello as protocol.NodeHello
    expect(P.parseNodeMessage(encode(typed as any))).toEqual(nodeHello)
    expect(P.NODE_ROLE).toBe("node")
  })

  test("a v1 spoke hello is unchanged; a node hello is never a spoke hello and vice versa", () => {
    expect(parseSpokeMessage(j(spokeHello))).toEqual(spokeHello as any)
    expect(parseSpokeMessage(j(nodeHello))).toBeUndefined()
    // Even with every spoke field present, role "node" is not a spoke.
    expect(parseSpokeMessage(j({ ...spokeHello, role: "node" }))).toBeUndefined()
    expect(parseSpokeMessage(j({ ...spokeHello, role: "spoke" }))).toBeDefined()
    expect(parseSpokeMessage(j({ ...spokeHello, role: "robot" }))).toBeUndefined()
    expect(node(spokeHello)).toBeUndefined()
  })

  test("helloRole tells the first frame's role (undefined when it is no hello)", () => {
    expect(P.helloRole(j(nodeHello))).toBe("node")
    expect(P.helloRole(j(spokeHello))).toBe("spoke")
    expect(P.helloRole(j({ t: "sessions", sessions: [] }))).toBeUndefined()
    expect(P.helloRole("{")).toBeUndefined()
  })

  test("requires every report field", () => {
    for (const key of ["v", "instanceID", "nodeVersion", "runtimes", "labels", "capacity", "used", "workspaceRoots", "draining", "launches"]) {
      expect(node({ ...nodeHello, [key]: undefined })).toBeUndefined()
    }
    expect(node({ ...nodeHello, features: ["x"] })).toBeDefined()
    expect(node({ ...nodeHello, features: "x" })).toBeUndefined()
  })

  test("runtimes are known-shaped: a kind token with token lists, at most 8", () => {
    expect(node({ ...nodeHello, runtimes: [] })).toBeDefined()
    for (const runtimes of [[{ kind: "" }], [{ kind: "Host Runtime" }], [{ kind: "host", harnesses: "opencode" }], [{ kind: "host", profiles: [5] }], Array(9).fill({ kind: "host" }), "host"]) {
      expect(node({ ...nodeHello, runtimes })).toBeUndefined()
    }
  })

  test("capacity and used are whole, non-negative slots and optional memory", () => {
    expect(node({ ...nodeHello, capacity: { slots: 0 }, used: { slots: 0 } })).toBeDefined()
    for (const capacity of [{}, { slots: -1 }, { slots: 1.5 }, { slots: 10_001 }, { slots: 1, memoryMB: -5 }, { slots: 1, memoryMB: "lots" }]) {
      expect(node({ ...nodeHello, capacity })).toBeUndefined()
      expect(node({ ...nodeHello, used: capacity })).toBeUndefined()
    }
  })

  test("labels follow the launch label rules; roots are absolute paths, at most 32", () => {
    expect(node({ ...nodeHello, labels: { "a b": "x" } })).toBeUndefined()
    for (const workspaceRoots of [["relative"], ["/a/../b"], Array(33).fill("/r"), "/r"]) expect(node({ ...nodeHello, workspaceRoots })).toBeUndefined()
  })

  test("launches name a launch, its phase and optionally its directory", () => {
    expect(P.NODE_LAUNCH_PHASES).toEqual(["preparing", "prepared", "collecting", "collected", "cleaning", "cleaned", "cancelled", "failed"])
    expect(node({ ...nodeHello, launches: [] })).toBeDefined()
    for (const launches of [[{ launchID: "", phase: "prepared" }], [{ launchID: "l", phase: "flying" }], [{ launchID: "l", phase: "prepared", directory: "rel" }], "x"]) {
      expect(node({ ...nodeHello, launches })).toBeUndefined()
    }
  })
})

describe("node → hub frames", () => {
  test("capacity replaces the node's capacity, use, draining flag and (optionally) labels", () => {
    const frame = { t: "capacity", capacity: { slots: 6 }, used: { slots: 3, memoryMB: 100 }, draining: true }
    expect(node(frame)).toEqual(frame)
    expect(node({ ...frame, labels: { os: "linux" } })).toBeDefined()
    expect(node({ ...frame, draining: "yes" })).toBeUndefined()
    expect(node({ ...frame, used: undefined })).toBeUndefined()
  })

  test("progress reports a launch's phase with a short printable message", () => {
    const frame = { t: "progress", launchID: "lch_1", phase: "preparing", message: "cloning github.com/huynle/hub" }
    expect(node(frame)).toEqual(frame)
    expect(node({ t: "progress", launchID: "lch_1", phase: "failed" })).toBeDefined()
    expect(P.NODE_MESSAGE_MAX).toBe(500)
    for (const bad of [{ message: "x".repeat(501) }, { message: "a\u001b[31m" }, { phase: "running" }, { launchID: "a b" }]) expect(node({ ...frame, ...bad })).toBeUndefined()
  })

  test("res and bye are shared with the spoke protocol; spoke frames are not node frames", () => {
    expect(node({ t: "res", id: "n1", ok: true, result: { cancelled: true } })).toBeDefined()
    expect(node({ t: "bye", reason: "draining" })).toBeDefined()
    expect(node({ t: "sessions", sessions: [] })).toBeUndefined()
    expect(node({ t: "event", event: { type: "session.created", data: {} } })).toBeUndefined()
    expect(node({ t: "req", id: "1", req: { op: "pairCode" } })).toBeUndefined()
    expect(P.parseNodeMessage("x".repeat(1_000_001))).toBeUndefined()
  })
})

describe("hub → node ops", () => {
  test("prepare carries the launch, runtime, harness and workspace spec", () => {
    const r = { op: "prepare", launchID: "lch_1", runtime: { kind: "host" }, harness: "opencode", workspace: { repo: "/Users/huy/projects/hub", mode: "worktree", branch: "feat/x", base: "main" } }
    expect(req(r)).toEqual({ t: "req", id: "n1", req: r })
    expect(req({ ...r, workspace: { repo: "/r", mode: "worktree", branch: "--upload-pack=x" } })).toBeUndefined()
    expect(req({ ...r, runtime: { kind: "vm" } })).toBeUndefined()
    expect(req({ ...r, harness: "Open Code" })).toBeUndefined()
    expect(req({ ...r, launchID: undefined })).toBeUndefined()
  })

  test("collect and cleanup carry the prepared workspace; cleanup a keep/remove policy", () => {
    expect(req({ op: "collect", launchID: "lch_1", workspace: prepared })).toBeDefined()
    expect(req({ op: "cleanup", launchID: "lch_1", workspace: prepared, policy: "remove" })).toBeDefined()
    expect(req({ op: "cleanup", launchID: "lch_1", workspace: prepared, policy: "force" })).toBeUndefined()
    expect(req({ op: "collect", launchID: "lch_1", workspace: { ...prepared, directory: "rel" } })).toBeUndefined()
    expect(req({ op: "collect", launchID: "lch_1", workspace: { ...prepared, reused: "no" } })).toBeUndefined()
  })

  test("cancel names only the launch", () => {
    expect(req({ op: "cancel", launchID: "lch_1" })).toBeDefined()
    expect(req({ op: "cancel" })).toBeUndefined()
  })

  test("there is no exec op, and spoke ops are not node ops", () => {
    for (const op of ["exec", "shell", "turn", "create", "deliver"]) expect(req({ op, launchID: "lch_1", sessionID: "s", directory: "/d", text: "x", voiceStyle: false })).toBeUndefined()
  })

  test("the node accepts the welcome, res and bye", () => {
    const welcome = { t: "welcome", v: PROTOCOL_VERSION, machineID: "m_1", publicURL: "https://hub.example", features: [...HUB_FEATURES] }
    expect(fromHub(welcome)).toEqual(welcome)
    expect(fromHub({ t: "bye", reason: "revoked" })).toBeDefined()
    expect(fromHub({ t: "res", id: "x", ok: false, error: "nope" })).toBeDefined()
  })
})

describe("node op results", () => {
  test("nodeResultProblem checks each op's result", () => {
    expect(P.nodeResultProblem("prepare", { workspace: prepared })).toBeUndefined()
    expect(P.nodeResultProblem("prepare", { workspace: { ...prepared, head: "zz" } })).toMatch(/head/)
    expect(P.nodeResultProblem("prepare", {})).toMatch(/workspace/)
    expect(P.nodeResultProblem("collect", { artifacts: { branch: "feat/x", head: "0123abcd", commits: 2, dirty: false } })).toBeUndefined()
    expect(P.nodeResultProblem("collect", { artifacts: {} })).toBeUndefined()
    expect(P.nodeResultProblem("collect", { artifacts: { commits: -1 } })).toMatch(/commits/)
    expect(P.nodeResultProblem("cleanup", { removed: true })).toBeUndefined()
    expect(P.nodeResultProblem("cleanup", { removed: false, reason: "uncommitted changes" })).toBeUndefined()
    expect(P.nodeResultProblem("cleanup", { removed: "y" })).toMatch(/removed/)
    expect(P.nodeResultProblem("cancel", { cancelled: false })).toBeUndefined()
    expect(P.nodeResultProblem("cancel", null)).toBeDefined()
  })
})

describe("hub features", () => {
  test("the hub announces nodes and launches; hubServesNodes reads a welcome", () => {
    expect(KNOWN_HUB_FEATURES as readonly string[]).toEqual(expect.arrayContaining(["harness", "messaging", "nodes", "launches"]))
    // Announced once the hub serves them: nodes (P4-T4); launches with the launch routes (P4-T9).
    expect(HUB_FEATURES as readonly string[]).toContain("nodes")
    expect(HUB_FEATURES as readonly string[]).not.toContain("launches")
    expect(P.hubServesNodes({ t: "welcome", v: 1, machineID: "m", publicURL: "", features: ["harness", "nodes"] })).toBe(true)
    expect(P.hubServesNodes({ t: "welcome", v: 1, machineID: "m", publicURL: "", features: ["harness"] })).toBe(false)
    expect(P.hubServesNodes({ t: "welcome", v: 1, machineID: "m", publicURL: "" })).toBe(false)
  })
})
