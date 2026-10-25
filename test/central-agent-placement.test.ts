// Placement (design §6.2, §9; decision znbg8xa5): which of the user's nodes takes a launch. A pure matcher over a
// snapshot of the user's connected nodes (owner machines only, not draining, runtime + harness, workspace roots,
// labels and machine required or preferred, free slots minus reservations, a connected service spoke announcing
// "launch" for host launches), then per-user admission caps and a FIFO placement pass under a fenced lease.
import { describe, expect, test } from "bun:test"
import { type LaunchSpec, validateLaunchSpec } from "../src/central/agent/launch-spec"
import { LaunchStore } from "../src/central/agent/launch-store"
import {
  type Candidate,
  DEFAULT_LAUNCH_CAPS,
  matchNode,
  type PassResult,
  type Placed,
  Placement,
  PlacementLoop,
  type PlacementNode,
} from "../src/central/agent/placement"
import type { HubLaunches } from "../src/central/config"
import { MemoryCounters, MemoryLocks } from "../src/central/backend/memory-counters"
import { MemoryStateStore } from "../src/central/backend/memory-state"

const U = "u1"
const HOUR = 3_600_000
/** 10:00:00 on some day: the hour bucket starts here. */
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % HOUR)

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

// ---- admission and the placement pass ---------------------------------------------------------------------

const live = (extra: Partial<PlacementNode> = {}): PlacementNode => {
  const { launchService: _s, reserved: _r, ...plain } = node()
  return { ...plain, ...extra }
}

function setup(options: { caps?: HubLaunches; nodes?: PlacementNode[]; service?: (machineID: string) => boolean; leaseMs?: number } = {}) {
  let t = T0
  let n = 0
  const now = () => t
  const state = new MemoryStateStore({ now })
  const store = new LaunchStore({ state, now, newID: () => `l_${String(++n).padStart(4, "0")}` })
  const counters = new MemoryCounters({ now })
  const locks = new MemoryLocks({ now })
  const world = { nodes: options.nodes ?? [live()], before: async () => {} }
  const placement = new Placement({
    store,
    counters,
    locks,
    owner: "pod-a",
    now,
    ...(options.caps ? { caps: options.caps } : {}),
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    nodes: {
      nodes: async () => {
        await world.before()
        return world.nodes
      },
    },
    spokes: { launchService: (_user, machineID) => (options.service ?? (() => true))(machineID) },
  })
  const launch = async (extra: Record<string, unknown> = {}, user = U) => (await store.create(user, spec(extra))).launch
  return { placement, store, counters, locks, world, launch, advance: (ms: number) => (t += ms), now }
}

describe("Placement.admit: per-user caps", () => {
  test("defaults", () => {
    expect(DEFAULT_LAUNCH_CAPS).toEqual({ maxQueued: 50, maxActive: 4, perHour: 60 })
    expect(new Placement({ ...setupDeps() }).caps).toEqual(DEFAULT_LAUNCH_CAPS)
    expect(new Placement({ ...setupDeps(), caps: { maxActive: 2 } }).caps).toEqual({ ...DEFAULT_LAUNCH_CAPS, maxActive: 2 })
  })

  test("maxQueued: a user with that many queued launches is rate_limited; other users are not", async () => {
    const { placement, launch } = setup({ caps: { maxQueued: 2 } })
    await placement.admit(U)
    await launch()
    await launch()
    await expect(placement.admit(U)).rejects.toMatchObject({ code: "rate_limited", options: { extra: { retryAfter: 60 } } })
    await expect(placement.admit(U)).rejects.toThrow(/2 launches are queued/)
    await placement.admit("u2")
  })

  test("perHour: recorded launches count per clock hour; retryAfter is the rest of the hour", async () => {
    const { placement, advance } = setup({ caps: { perHour: 2 } })
    await placement.admit(U)
    await placement.recordLaunch(U)
    advance(10 * 60_000)
    await placement.recordLaunch(U)
    await expect(placement.admit(U)).rejects.toMatchObject({ code: "rate_limited", options: { extra: { retryAfter: 50 * 60 } } })
    await expect(placement.admit(U)).rejects.toThrow(/2 launches this hour/)
    await placement.admit("u2")
    advance(50 * 60_000)
    await placement.admit(U)
  })

  test("admit itself consumes nothing (an idempotent retry is not counted)", async () => {
    const { placement } = setup({ caps: { perHour: 1 } })
    for (let i = 0; i < 5; i++) await placement.admit(U)
    await placement.recordLaunch(U)
    await expect(placement.admit(U)).rejects.toMatchObject({ code: "rate_limited" })
  })
})

function setupDeps() {
  const now = () => T0
  const state = new MemoryStateStore({ now })
  return {
    store: new LaunchStore({ state, now }),
    counters: new MemoryCounters({ now }),
    locks: new MemoryLocks({ now }),
    owner: "pod-a",
    nodes: { nodes: () => [] },
    spokes: { launchService: () => false },
  }
}

describe("Placement.place: one pass for one user", () => {
  test("queued launches are placed in FIFO order onto fitting nodes: placing, then provisioning on the machine", async () => {
    const { placement, store, launch } = setup()
    const a = await launch()
    const b = await launch()
    const result = await placement.place(U)
    expect(result.leased).toBe(true)
    expect(result.placed.map((p) => [p.launch.id, p.node.machineID, p.fence])).toEqual([
      [a.id, "m1", 1],
      [b.id, "m1", 1],
    ])
    const placed = await store.get(U, a.id)
    expect(placed).toMatchObject({ state: "provisioning", machineID: "m1", reason: "Placed on mbp" })
    expect(placed!.history.map((step) => step.state)).toEqual(["queued", "placing", "provisioning"])
    expect(result.placed[0]!.launch).toEqual(placed!)
  })

  test("free slots shrink as the pass places; the rest wait with a reason", async () => {
    const { placement, store, launch } = setup({ nodes: [live({ capacity: { slots: 1 } })] })
    const a = await launch()
    const b = await launch()
    const result = await placement.place(U)
    expect(result.placed.map((p) => p.launch.id)).toEqual([a.id])
    expect(result.waiting).toEqual([{ launchID: b.id, wait: "capacity", reason: "Waiting for a free slot on mbp" }])
    expect((await store.get(U, b.id))?.state).toBe("queued")
  })

  test("reservations: launches placed on a machine that the node does not report yet take a slot", async () => {
    const { placement, world, launch } = setup({ nodes: [live({ capacity: { slots: 2 } })] })
    const a = await launch()
    expect((await placement.place(U)).placed).toHaveLength(1)
    // The node still reports nothing used; the provisioning launch is reserved.
    await launch()
    await launch()
    expect((await placement.place(U)).placed).toHaveLength(1)
    // Once the node reports a launch it counts in used, not twice.
    world.nodes = [live({ capacity: { slots: 2 }, used: { slots: 1 }, launchIDs: [a.id] })]
    const c = await launch()
    const result = await placement.place(U)
    expect(result.placed).toHaveLength(0)
    expect(result.waiting.map((w) => w.launchID)).not.toContain(a.id)
    expect(result.waiting).toHaveLength(2)
    expect(result.waiting.at(-1)!.launchID).toBe(c.id)
  })

  test("a launch that fits nowhere does not block later ones (earlier ones still pick first)", async () => {
    const { placement, launch } = setup({ nodes: [live({ capacity: { slots: 1 } })] })
    const stuck = await launch({ placement: { machine: "elsewhere" } })
    const ok = await launch()
    const result = await placement.place(U)
    expect(result.placed.map((p) => p.launch.id)).toEqual([ok.id])
    expect(result.waiting).toEqual([{ launchID: stuck.id, wait: "no_match", reason: "No node fits: mbp is not elsewhere" }])
  })

  test("maxActive: placed-and-live launches count; the rest wait without being matched", async () => {
    const { placement, store, launch } = setup({ caps: { maxActive: 2 }, nodes: [live({ capacity: { slots: 9 } })] })
    const a = await launch()
    await launch()
    await placement.place(U)
    await store.transition(U, a.id, "running", { reason: "Session started", sessionID: "ses_1" })
    const c = await launch()
    let result = await placement.place(U)
    expect(result.placed).toEqual([])
    expect(result.waiting).toEqual([{ launchID: c.id, wait: "active", reason: "Waiting: 2 launches are active (the most per user)" }])
    await store.transition(U, a.id, "ended", { reason: "Done", outcome: "idle" })
    result = await placement.place(U)
    expect(result.placed.map((p) => p.launch.id)).toEqual([c.id])
  })

  test("only the user's own launches and nodes: another user's node is never used", async () => {
    const { placement, launch } = setup({ nodes: [live({ owner: "u2" })] })
    const mine = await launch()
    const result = await placement.place(U)
    expect(result.placed).toEqual([])
    expect(result.waiting).toEqual([{ launchID: mine.id, wait: "no_match", reason: "No node is connected" }])
  })

  test("the service spoke is asked per machine", async () => {
    const { placement, launch } = setup({ nodes: [live(), live({ machineID: "m2", name: "lab", capacity: { slots: 9 } })], service: (m) => m === "m1" })
    await launch()
    expect((await placement.place(U)).placed.map((p) => p.node.machineID)).toEqual(["m1"])
  })

  test("prefer: a launch placed away from its preference says so", async () => {
    const { placement, store, launch } = setup({ nodes: [live({ machineID: "m2", name: "lab" })] })
    const a = await launch({ placement: { machine: "mbp", mode: "prefer" } })
    const result = await placement.place(U)
    expect(result.placed[0]).toMatchObject({ preferred: false })
    expect((await store.get(U, a.id))?.reason).toBe("Placed on lab (preferred placement not available)")
  })

  test("nothing queued: no node lookup", async () => {
    const { placement, world } = setup()
    let asked = 0
    world.before = async () => {
      asked++
    }
    expect(await placement.place(U)).toEqual({ leased: true, placed: [], waiting: [] })
    expect(asked).toBe(0)
  })

  test("a launch stopped meanwhile is skipped, not an error", async () => {
    const { placement, store, world, launch } = setup()
    const a = await launch()
    const b = await launch()
    world.before = async () => {
      await store.transition(U, a.id, "ended", { reason: "Stopped", outcome: "stopped" })
    }
    const result = await placement.place(U)
    expect(result.placed.map((p) => p.launch.id)).toEqual([b.id])
    expect((await store.get(U, a.id))?.state).toBe("ended")
  })
})

describe("Placement.place: the per-user lease", () => {
  test("another holder's lease: the pass does nothing", async () => {
    const { placement, locks, store, launch } = setup()
    const a = await launch()
    await locks.acquire(`placement:${U}`, "pod-b", 15_000)
    expect(await placement.place(U)).toEqual({ leased: false, placed: [], waiting: [] })
    expect((await store.get(U, a.id))?.state).toBe("queued")
  })

  test("the lease is released after the pass, and fences grow per pass", async () => {
    const { placement, locks, launch } = setup()
    await launch()
    expect((await placement.place(U)).placed[0]!.fence).toBe(1)
    expect(await locks.holder(`placement:${U}`)).toBeUndefined()
    await launch()
    expect((await placement.place(U)).placed[0]!.fence).toBe(2)
  })

  test("a lease lost mid-pass (expired and taken) stops the pass before any write", async () => {
    const { placement, locks, store, world, launch, advance } = setup({ leaseMs: 5_000 })
    const a = await launch()
    world.before = async () => {
      advance(6_000)
      await locks.acquire(`placement:${U}`, "pod-b", 15_000)
    }
    const result = await placement.place(U)
    expect(result).toEqual({ leased: false, placed: [], waiting: [] })
    expect((await store.get(U, a.id))?.state).toBe("queued")
    expect((await locks.holder(`placement:${U}`))?.owner).toBe("pod-b")
  })

  test("launches left placing by a crashed holder go back to the queue in their place", async () => {
    const { placement, store, launch } = setup({ nodes: [live({ capacity: { slots: 1 } })] })
    const a = await launch()
    const b = await launch()
    await store.transition(U, a.id, "placing", { reason: "Placing" })
    const result = await placement.place(U)
    expect(result.placed.map((p) => p.launch.id)).toEqual([a.id])
    expect((await store.get(U, a.id))!.history.map((step) => [step.state, step.reason])).toEqual([
      ["queued", "Queued"],
      ["placing", "Placing"],
      ["queued", "Placement interrupted; queued again"],
      ["placing", "Placing on mbp"],
      ["provisioning", "Placed on mbp"],
    ])
    expect(result.waiting.map((w) => w.launchID)).toEqual([b.id])
  })
})

// ---- the loop ---------------------------------------------------------------------------------------------

class FakeTimers {
  pending = new Map<number, { fn: () => void; ms: number }>()
  private next = 0
  set(fn: () => void, ms: number) {
    const id = ++this.next
    this.pending.set(id, { fn, ms })
    return id
  }
  clear(handle: unknown) {
    this.pending.delete(handle as number)
  }
  /** Runs every pending timer once. */
  fire() {
    const due = [...this.pending.values()]
    this.pending.clear()
    for (const timer of due) timer.fn()
  }
}

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

function fakePlacement() {
  const calls: string[] = []
  let gate: Promise<void> | undefined
  let open: () => void = () => {}
  const results = new Map<string, PassResult>()
  const placement = {
    calls,
    results,
    hold() {
      gate = new Promise((resolve) => (open = resolve))
    },
    release() {
      gate = undefined
      open()
    },
    async place(userID: string): Promise<PassResult> {
      calls.push(userID)
      if (gate) await gate
      return results.get(userID) ?? { leased: true, placed: [], waiting: [] }
    },
  }
  return placement
}

const placedOf = (launchID: string): Placed => ({
  userID: U,
  launch: { id: launchID } as Placed["launch"],
  node: live(),
  preferred: true,
  fence: 1,
})

describe("PlacementLoop", () => {
  test("kick runs a pass and hands each placed launch to onPlaced", async () => {
    const placement = fakePlacement()
    placement.results.set(U, { leased: true, placed: [placedOf("l_1"), placedOf("l_2")], waiting: [] })
    const handed: string[] = []
    const loop = new PlacementLoop({ placement, users: async () => [], timers: new FakeTimers(), onPlaced: (p) => void handed.push(p.launch.id) })
    await loop.kick(U)
    expect(placement.calls).toEqual([U])
    expect(handed).toEqual(["l_1", "l_2"])
  })

  test("kicks during a running pass coalesce into one more pass; users run independently", async () => {
    const placement = fakePlacement()
    const loop = new PlacementLoop({ placement, users: async () => [], timers: new FakeTimers(), onPlaced: () => {} })
    placement.hold()
    const first = loop.kick(U)
    await flush()
    const second = loop.kick(U)
    const third = loop.kick(U)
    const other = loop.kick("u2")
    await flush()
    expect(placement.calls).toEqual([U, "u2"])
    placement.release()
    await Promise.all([first, second, third, other])
    expect(placement.calls).toEqual([U, "u2", U])
    await loop.kick(U)
    expect(placement.calls).toEqual([U, "u2", U, U])
  })

  test("start sweeps every intervalMs over the users; stop ends it", async () => {
    const placement = fakePlacement()
    const timers = new FakeTimers()
    const loop = new PlacementLoop({ placement, users: async () => [U, "u2"], timers, intervalMs: 2_000, onPlaced: () => {} })
    loop.start()
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([2_000])
    timers.fire()
    await flush()
    expect(placement.calls).toEqual([U, "u2"])
    expect(timers.pending.size).toBe(1)
    loop.start()
    expect(timers.pending.size).toBe(1)
    timers.fire()
    await flush()
    expect(placement.calls).toEqual([U, "u2", U, "u2"])
    loop.stop()
    expect(timers.pending.size).toBe(0)
  })

  test("failures go to onError and never stop the loop", async () => {
    const errors: [unknown, string | undefined][] = []
    let fail = true
    const placement = {
      async place(userID: string): Promise<PassResult> {
        if (fail && userID === U) throw new Error("store down")
        return { leased: true, placed: [placedOf("l_9")], waiting: [] }
      },
    }
    const timers = new FakeTimers()
    let usersFail = true
    const loop = new PlacementLoop({
      placement,
      users: async () => {
        if (usersFail) throw new Error("no users")
        return [U, "u2"]
      },
      timers,
      onPlaced: () => {
        throw new Error("engine down")
      },
      onError: (cause, userID) => void errors.push([(cause as Error).message, userID]),
    })
    await loop.kick(U)
    loop.start()
    timers.fire()
    await flush()
    usersFail = false
    timers.fire()
    await flush()
    fail = false
    await loop.kick(U)
    expect(errors).toEqual([
      ["store down", U],
      ["no users", undefined],
      ["store down", U],
      ["engine down", "u2"],
      ["engine down", U],
    ])
    loop.stop()
  })

  test("end to end with the real Placement: a kick moves a queued launch to provisioning", async () => {
    const { placement, store, launch } = setup()
    const a = await launch()
    const handed: Placed[] = []
    const loop = new PlacementLoop({ placement, users: async () => [U], timers: new FakeTimers(), onPlaced: (p) => void handed.push(p) })
    await loop.kick(U)
    expect(handed.map((p) => p.launch.id)).toEqual([a.id])
    expect((await store.get(U, a.id))?.state).toBe("provisioning")
  })
})
