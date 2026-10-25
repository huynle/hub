// Placement (design §6.2, §9; decision znbg8xa5): which of the user's nodes takes a launch. A pure matcher over a
// snapshot of the user's connected nodes (owner machines only, not draining, runtime + harness, workspace roots,
// labels and machine required or preferred, free slots minus reservations, a connected service spoke announcing
// "launch" for host launches), then per-user admission caps and a FIFO placement pass under a fenced lease.
import { describe, expect, test } from "bun:test"
import { type LaunchSpec, validateLaunchSpec } from "../src/central/agent/launch-spec"
import { type Candidate, matchNode } from "../src/central/agent/placement"

const U = "u1"

const spec = (extra: Record<string, unknown> = {}): LaunchSpec =>
  validateLaunchSpec({ workspace: { repo: "/p/hub", branch: "feat/x" }, ...extra })

const node = (extra: Partial<Candidate> = {}): Candidate => ({
  machineID: "m1",
  name: "mbp",
  owner: U,
  runtimes: [{ kind: "host", harnesses: ["opencode"] }],
  labels: { os: "darwin" },
  capacity: { slots: 2 },
  used: { slots: 0 },
  workspaceRoots: ["/p"],
  draining: false,
  launchIDs: [],
  launchService: true,
  reserved: 0,
  ...extra,
})

describe("matchNode: hard constraints", () => {
  test("a fitting node is chosen", () => {
    expect(matchNode(U, spec(), [node()])).toEqual({ ok: true, node: node(), preferred: true })
  })

  test("no nodes at all: no_match", () => {
    expect(matchNode(U, spec(), [])).toEqual({ ok: false, wait: "no_match", reason: "No node is connected" })
  })

  test("another user's node never takes it, even if offered", () => {
    const result = matchNode(U, spec(), [node({ owner: "u2" })])
    expect(result).toMatchObject({ ok: false, wait: "no_match" })
  })

  test("a draining node takes nothing", () => {
    expect(matchNode(U, spec(), [node({ draining: true })])).toEqual({ ok: false, wait: "no_match", reason: "No node fits: mbp is draining" })
  })

  test("the runtime kind must be offered", () => {
    const result = matchNode(U, spec({ runtime: { kind: "openshell", profile: "net-off" }, workspace: { repo: "/p/x", mode: "clone", remote: "https://github.com/a/b" } }), [node()])
    expect(result).toEqual({ ok: false, wait: "no_match", reason: "No node fits: mbp has no openshell runtime" })
  })

  test("host: the harness must be listed", () => {
    const result = matchNode(U, spec({ harness: "claude" }), [node()])
    expect(result).toEqual({ ok: false, wait: "no_match", reason: "No node fits: mbp has no claude harness" })
  })

  test("openshell: the profile must be listed; harnesses are checked only when listed", () => {
    const shell = spec({ runtime: { kind: "openshell", profile: "net-off" }, workspace: { repo: "/p/x", mode: "clone", remote: "https://github.com/a/b" } })
    const sandbox = node({ runtimes: [{ kind: "openshell", profiles: ["untrusted-code"] }], launchService: false })
    expect(matchNode(U, shell, [sandbox])).toEqual({ ok: false, wait: "no_match", reason: "No node fits: mbp has no net-off profile" })
    const ok = node({ runtimes: [{ kind: "openshell", profiles: ["net-off"] }], launchService: false })
    expect(matchNode(U, shell, [ok])).toMatchObject({ ok: true })
    const listed = node({ runtimes: [{ kind: "openshell", profiles: ["net-off"], harnesses: ["claude"] }], launchService: false })
    expect(matchNode(U, shell, [listed])).toEqual({ ok: false, wait: "no_match", reason: "No node fits: mbp has no opencode harness" })
  })

  test("the workspace must be under one of the node's roots (path components, not prefixes)", () => {
    expect(matchNode(U, spec({ workspace: { repo: "/px/hub", branch: "b" } }), [node()])).toEqual({
      ok: false,
      wait: "no_match",
      reason: "No node fits: mbp does not serve /px/hub",
    })
    expect(matchNode(U, spec({ workspace: { repo: "/p", branch: "b" } }), [node()])).toMatchObject({ ok: true })
    expect(matchNode(U, spec({ workspace: { repo: "/q/r/s", branch: "b" } }), [node({ workspaceRoots: ["/x", "/q/r/"] })])).toMatchObject({ ok: true })
  })

  test("host launches need the machine's service spoke announcing launch", () => {
    expect(matchNode(U, spec(), [node({ launchService: false })])).toEqual({
      ok: false,
      wait: "no_match",
      reason: "No node fits: mbp has no connected service spoke with launch",
    })
  })

  test("reasons name every node; the machine ID stands in for a missing name", () => {
    const result = matchNode(U, spec(), [node({ draining: true }), node({ machineID: "m2", name: undefined, launchService: false })])
    expect(result).toEqual({ ok: false, wait: "no_match", reason: "No node fits: mbp is draining; m2 has no connected service spoke with launch" })
  })
})

describe("matchNode: capacity", () => {
  test("free slots are capacity minus used minus reservations", () => {
    expect(matchNode(U, spec(), [node({ used: { slots: 1 }, reserved: 1 })])).toEqual({
      ok: false,
      wait: "capacity",
      reason: "Waiting for a free slot on mbp",
    })
    expect(matchNode(U, spec(), [node({ used: { slots: 1 } })])).toMatchObject({ ok: true })
  })

  test("among fitting nodes the one with most free slots wins, then the lower machine ID", () => {
    const a = node({ machineID: "m1", name: "a", capacity: { slots: 4 }, used: { slots: 3 } })
    const b = node({ machineID: "m2", name: "b", capacity: { slots: 4 }, used: { slots: 1 } })
    const c = node({ machineID: "m0", name: "c", capacity: { slots: 4 }, used: { slots: 1 } })
    expect(matchNode(U, spec(), [a, b, c])).toMatchObject({ ok: true, node: { machineID: "m0" } })
  })

  test("a no_match node does not hide a full one: capacity wins the wait reason", () => {
    const full = node({ machineID: "m1", name: "a", used: { slots: 2 } })
    const draining = node({ machineID: "m2", name: "b", draining: true })
    expect(matchNode(U, spec(), [draining, full])).toEqual({ ok: false, wait: "capacity", reason: "Waiting for a free slot on a" })
  })
})

describe("matchNode: labels and machine, required or preferred", () => {
  test("require: every placement label must match", () => {
    const s = spec({ placement: { labels: { os: "linux" } } })
    expect(matchNode(U, s, [node()])).toEqual({ ok: false, wait: "no_match", reason: "No node fits: mbp lacks label os=linux" })
    expect(matchNode(U, s, [node({ labels: { os: "linux", gpu: "yes" } })])).toMatchObject({ ok: true, preferred: true })
  })

  test("require: the machine must be the named one (by name or ID)", () => {
    const other = node({ machineID: "m2", name: "lab" })
    expect(matchNode(U, spec({ placement: { machine: "mbp" } }), [other, node()])).toMatchObject({ ok: true, node: { machineID: "m1" } })
    expect(matchNode(U, spec({ placement: { machine: "m2" } }), [node(), other])).toMatchObject({ ok: true, node: { machineID: "m2" } })
    expect(matchNode(U, spec({ placement: { machine: "nope" } }), [node()])).toEqual({ ok: false, wait: "no_match", reason: "No node fits: mbp is not nope" })
  })

  test("require: a full named machine is waited for, never bypassed", () => {
    const s = spec({ placement: { machine: "mbp" } })
    expect(matchNode(U, s, [node({ used: { slots: 2 } }), node({ machineID: "m2", name: "lab" })])).toEqual({
      ok: false,
      wait: "capacity",
      reason: "Waiting for a free slot on mbp",
    })
  })

  test("prefer: a matching node wins over more free slots elsewhere", () => {
    const s = spec({ placement: { machine: "mbp", labels: { os: "darwin" }, mode: "prefer" } })
    const lab = node({ machineID: "m0", name: "lab", labels: {}, capacity: { slots: 9 } })
    expect(matchNode(U, s, [lab, node({ used: { slots: 1 } })])).toMatchObject({ ok: true, node: { machineID: "m1" }, preferred: true })
  })

  test("prefer: with no preferred node free, any fitting node takes it (preferred false)", () => {
    const s = spec({ placement: { machine: "mbp", mode: "prefer" } })
    const lab = node({ machineID: "m2", name: "lab" })
    expect(matchNode(U, s, [node({ used: { slots: 2 } }), lab])).toEqual({ ok: true, node: lab, preferred: false })
    expect(matchNode(U, spec({ placement: { labels: { gpu: "yes" }, mode: "prefer" } }), [lab])).toEqual({ ok: true, node: lab, preferred: false })
  })

  test("prefer never relaxes the hard constraints", () => {
    const s = spec({ placement: { machine: "mbp", mode: "prefer" } })
    expect(matchNode(U, s, [node({ draining: true })])).toEqual({ ok: false, wait: "no_match", reason: "No node fits: mbp is draining" })
  })
})
