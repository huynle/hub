// The launch store (design §6.1, §9; decision znbg8xa5): launches per user in the StateStore collection
// "launches", moving queued → placing → provisioning → running → ended{outcome}, each step with a reason and time;
// illegal transitions throw. Idempotency per user through a StateStore claim on the key: the same body returns
// the same launch, a different body is invalid with a hint. Ended launches are pruned by age and count.
import { describe, expect, test } from "bun:test"
import { AgentError } from "../src/central/agent/errors"
import { type LaunchSpec, validateLaunchSpec } from "../src/central/agent/launch-spec"
import { LAUNCHES, LaunchStore, LaunchTransitionError, REASON_MAX } from "../src/central/agent/launch-store"
import { MemoryStateStore } from "../src/central/backend/memory-state"

const T0 = 1_700_000_000_000
const DAY = 86_400_000
const U = "u1"

const spec = (extra: Record<string, unknown> = {}): LaunchSpec =>
  validateLaunchSpec({ workspace: { repo: "/p/hub", branch: "feat/x" }, labels: { app: "brain" }, ...extra })

function setup(options: { endedKeepMs?: number; endedMax?: number } = {}) {
  let t = T0
  let n = 0
  const now = () => t
  const state = new MemoryStateStore({ now })
  const store = new LaunchStore({ state, now, newID: () => `l_${String(++n).padStart(4, "0")}`, ...options })
  return { store, state, advance: (ms: number) => (t += ms), now }
}

async function walk(store: LaunchStore, id: string) {
  await store.transition(U, id, "placing", { reason: "Placing" })
  await store.transition(U, id, "provisioning", { reason: "Placed on mbp", machineID: "m1" })
  return store.transition(U, id, "running", { reason: "Session started", sessionID: "ses_1", name: "worker" })
}

describe("create", () => {
  test("a new launch is queued, stored under its id in the launches collection", async () => {
    const { store, state } = setup()
    const { launch, created } = await store.create(U, spec(), { by: "app:0123456789abcdef" })
    expect(created).toBe(true)
    expect(launch).toEqual({
      id: "l_0001",
      owner: U,
      spec: spec(),
      by: "app:0123456789abcdef",
      state: "queued",
      reason: "Queued",
      at: T0,
      created: T0,
      history: [{ state: "queued", reason: "Queued", at: T0 }],
    })
    expect((await state.get(U, LAUNCHES, "l_0001"))?.value).toEqual(launch)
    expect(await store.get(U, "l_0001")).toEqual(launch)
  })

  test("launches are per user: another user's id is not found", async () => {
    const { store } = setup()
    const { launch } = await store.create(U, spec())
    expect(await store.get("u2", launch.id)).toBeUndefined()
    await expect(store.transition("u2", launch.id, "placing", { reason: "x" })).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("idempotency", () => {
  test("the same key and body return the same launch", async () => {
    const { store } = setup()
    const first = await store.create(U, spec({ key: "k1" }))
    const again = await store.create(U, spec({ key: "k1", harness: "opencode" }))
    expect(again).toEqual({ launch: first.launch, created: false })
    expect(await store.list(U)).toHaveLength(1)
  })

  test("the same key with a different body is invalid, with a hint", async () => {
    const { store } = setup()
    await store.create(U, spec({ key: "k1", prompt: "one" }))
    const error = await store.create(U, spec({ key: "k1", prompt: "two" })).catch((e) => e)
    expect(error).toBeInstanceOf(AgentError)
    expect(error.code).toBe("invalid")
    expect(error.options.hint).toBeTruthy()
  })

  test("keys are per user", async () => {
    const { store } = setup()
    const a = await store.create(U, spec({ key: "k1" }))
    const b = await store.create("u2", spec({ key: "k1", prompt: "other" }))
    expect(b.created).toBe(true)
    expect(b.launch.id).not.toBe(a.launch.id)
  })

  test("concurrent creates with one key make one launch", async () => {
    const { store } = setup()
    const results = await Promise.all([store.create(U, spec({ key: "k" })), store.create(U, spec({ key: "k" })), store.create(U, spec({ key: "k" }))])
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.launch.id)).size).toBe(1)
    expect(await store.list(U)).toHaveLength(1)
  })

  test("an ended launch still answers its key", async () => {
    const { store } = setup()
    const { launch } = await store.create(U, spec({ key: "k" }))
    await store.transition(U, launch.id, "ended", { reason: "Stopped by the user", outcome: "stopped" })
    const again = await store.create(U, spec({ key: "k" }))
    expect(again.created).toBe(false)
    expect(again.launch.state).toBe("ended")
  })

  test("a key claimed by a creator that never stored its launch: busy briefly, then free", async () => {
    const { store, state, advance } = setup()
    await state.claim(`launch-keys:${U}`, "k", "l_crashed")
    const busy = await store.create(U, spec({ key: "k" })).catch((e) => e)
    expect(busy).toMatchObject({ code: "rate_limited" })
    advance(61_000)
    const { launch, created } = await store.create(U, spec({ key: "k" }))
    expect(created).toBe(true)
    expect((await state.claimOf(`launch-keys:${U}`, "k"))?.owner).toBe(launch.id)
  })
})

describe("transitions", () => {
  test("the happy path records each step with its reason and time, and the details", async () => {
    const { store, advance } = setup()
    const { launch } = await store.create(U, spec())
    advance(1000)
    await store.transition(U, launch.id, "placing", { reason: "Placing" })
    advance(1000)
    await store.transition(U, launch.id, "provisioning", { reason: "Placed on mbp", machineID: "m1" })
    advance(1000)
    await store.transition(U, launch.id, "running", { reason: "Session started", sessionID: "ses_1", name: "worker" })
    advance(1000)
    const ended = await store.transition(U, launch.id, "ended", { reason: "Idle for 30 s", outcome: "idle", artifacts: { branch: "feat/x" } })
    expect(ended).toMatchObject({
      state: "ended",
      outcome: "idle",
      reason: "Idle for 30 s",
      at: T0 + 4000,
      machineID: "m1",
      sessionID: "ses_1",
      name: "worker",
      artifacts: { branch: "feat/x" },
    })
    expect(ended.history).toEqual([
      { state: "queued", reason: "Queued", at: T0 },
      { state: "placing", reason: "Placing", at: T0 + 1000 },
      { state: "provisioning", reason: "Placed on mbp", at: T0 + 2000 },
      { state: "running", reason: "Session started", at: T0 + 3000 },
      { state: "ended", reason: "Idle for 30 s", at: T0 + 4000, outcome: "idle" },
    ])
    expect(await store.get(U, launch.id)).toEqual(ended)
  })

  test("any live state may end; placing may go back to queued", async () => {
    const { store } = setup()
    for (const upTo of ["queued", "placing", "provisioning", "running"] as const) {
      const { launch } = await store.create(U, spec())
      if (upTo !== "queued") await store.transition(U, launch.id, "placing", { reason: "p" })
      if (upTo === "provisioning" || upTo === "running") await store.transition(U, launch.id, "provisioning", { reason: "p", machineID: "m1" })
      if (upTo === "running") await store.transition(U, launch.id, "running", { reason: "r", sessionID: "ses_1" })
      expect((await store.transition(U, launch.id, "ended", { reason: "e", outcome: "failed" })).state).toBe("ended")
    }
    const { launch } = await store.create(U, spec())
    await store.transition(U, launch.id, "placing", { reason: "p" })
    expect((await store.transition(U, launch.id, "queued", { reason: "No node has a free slot" })).state).toBe("queued")
  })

  test("illegal transitions throw and change nothing", async () => {
    const { store } = setup()
    const { launch } = await store.create(U, spec())
    const illegal = [
      ["running", { reason: "skip", sessionID: "ses_1" }],
      ["provisioning", { reason: "skip", machineID: "m1" }],
      ["queued", { reason: "same" }],
    ] as const
    for (const [to, input] of illegal) {
      const error = await store.transition(U, launch.id, to, input).catch((e) => e)
      expect(error).toBeInstanceOf(LaunchTransitionError)
      expect(error).toMatchObject({ from: "queued", to })
    }
    expect((await store.get(U, launch.id))?.history).toHaveLength(1)
  })

  test("an ended launch never changes again (gone)", async () => {
    const { store } = setup()
    const { launch } = await store.create(U, spec())
    await store.transition(U, launch.id, "ended", { reason: "Stopped", outcome: "stopped" })
    for (const to of ["queued", "placing", "running", "ended"] as const) {
      const error = await store.transition(U, launch.id, to, { reason: "again", outcome: "failed", sessionID: "ses_1", machineID: "m1" }).catch((e) => e)
      expect(error).toBeInstanceOf(LaunchTransitionError)
      expect(error.code).toBe("gone")
    }
  })

  test("outcome is required to end and allowed only then; machine and session are required to provision and run", async () => {
    const { store } = setup()
    const { launch } = await store.create(U, spec())
    await expect(store.transition(U, launch.id, "ended", { reason: "x" })).rejects.toThrow(/outcome/)
    await expect(store.transition(U, launch.id, "ended", { reason: "x", outcome: "done" as any })).rejects.toThrow(/outcome/)
    await expect(store.transition(U, launch.id, "placing", { reason: "x", outcome: "idle" })).rejects.toThrow(/outcome/)
    await store.transition(U, launch.id, "placing", { reason: "p" })
    await expect(store.transition(U, launch.id, "provisioning", { reason: "x" })).rejects.toThrow(/machine/)
    await store.transition(U, launch.id, "provisioning", { reason: "p", machineID: "m1" })
    await expect(store.transition(U, launch.id, "running", { reason: "x" })).rejects.toThrow(/session/)
  })

  test("a reason is required; it is cleaned and bounded", async () => {
    const { store } = setup()
    const { launch } = await store.create(U, spec())
    await expect(store.transition(U, launch.id, "placing", { reason: "  " })).rejects.toThrow(/reason/)
    const placed = await store.transition(U, launch.id, "placing", { reason: ` a\u0000b\n${"x".repeat(REASON_MAX * 2)}` })
    expect(placed.reason.length).toBeLessThanOrEqual(REASON_MAX)
    expect(placed.reason.startsWith("a b x")).toBe(true)
  })

  test("from: the transition applies only from the expected state", async () => {
    const { store } = setup()
    const { launch } = await store.create(U, spec())
    await expect(store.transition(U, launch.id, "ended", { reason: "x", outcome: "stopped", from: ["running"] })).rejects.toBeInstanceOf(LaunchTransitionError)
    expect((await store.transition(U, launch.id, "ended", { reason: "x", outcome: "stopped", from: ["queued", "placing"] })).state).toBe("ended")
  })

  test("concurrent transitions: exactly one ending wins", async () => {
    const { store } = setup()
    const { launch } = await store.create(U, spec())
    await walk(store, launch.id)
    const results = await Promise.allSettled([
      store.transition(U, launch.id, "ended", { reason: "idle", outcome: "idle" }),
      store.transition(U, launch.id, "ended", { reason: "stopped", outcome: "stopped" }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect((await store.get(U, launch.id))?.history.filter((h) => h.state === "ended")).toHaveLength(1)
  })

  test("history is bounded (placing ↔ queued loops)", async () => {
    const { store } = setup()
    const { launch } = await store.create(U, spec())
    for (let i = 0; i < 40; i++) {
      await store.transition(U, launch.id, "placing", { reason: `try ${i}` })
      await store.transition(U, launch.id, "queued", { reason: `wait ${i}` })
    }
    const stored = await store.get(U, launch.id)
    expect(stored!.history.length).toBeLessThanOrEqual(20)
    expect(stored!.history.at(-1)).toEqual({ state: "queued", reason: "wait 39", at: T0 })
    expect(stored!.history[0]).toEqual({ state: "queued", reason: "Queued", at: T0 })
  })
})

describe("list", () => {
  test("by creation, filtered by labels and states", async () => {
    const { store, advance } = setup()
    const a = (await store.create(U, spec({ labels: { app: "brain", "brain.task": "abc" } }))).launch
    advance(1)
    const b = (await store.create(U, spec({ labels: { app: "brain", "brain.task": "def" } }))).launch
    advance(1)
    const c = (await store.create(U, spec({ labels: { app: "other" } }))).launch
    await store.transition(U, b.id, "ended", { reason: "x", outcome: "stopped" })
    const ids = (launches: { id: string }[]) => launches.map((l) => l.id)
    expect(ids(await store.list(U))).toEqual([a.id, b.id, c.id])
    expect(ids(await store.list(U, { labels: { app: "brain" } }))).toEqual([a.id, b.id])
    expect(ids(await store.list(U, { labels: { app: "brain", "brain.task": "def" } }))).toEqual([b.id])
    expect(ids(await store.list(U, { states: ["queued"] }))).toEqual([a.id, c.id])
    expect(await store.list("u2")).toEqual([])
  })
})

describe("prune", () => {
  test("removes ended launches older than endedKeepMs, keeps live ones, and frees their keys", async () => {
    const { store, state, advance } = setup({ endedKeepMs: DAY })
    const old = (await store.create(U, spec({ key: "old" }))).launch
    const live = (await store.create(U, spec({ key: "live" }))).launch
    await store.transition(U, old.id, "ended", { reason: "x", outcome: "failed" })
    advance(DAY - 1)
    expect(await store.prune(U)).toEqual([])
    advance(1)
    expect(await store.prune(U)).toEqual([old.id])
    expect(await store.get(U, old.id)).toBeUndefined()
    expect(await store.get(U, live.id)).toBeDefined()
    expect(await state.claimOf(`launch-keys:${U}`, "old")).toBeUndefined()
    expect((await store.create(U, spec({ key: "old", prompt: "new body" }))).created).toBe(true)
  })

  test("keeps at most endedMax ended launches (the newest)", async () => {
    const { store, advance } = setup({ endedMax: 2 })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const { launch } = await store.create(U, spec())
      await store.transition(U, launch.id, "ended", { reason: "x", outcome: "idle" })
      ids.push(launch.id)
      advance(1)
    }
    const live = (await store.create(U, spec())).launch
    expect((await store.prune(U)).sort()).toEqual([ids[0]!, ids[1]!])
    expect((await store.list(U)).map((l) => l.id)).toEqual([ids[2]!, ids[3]!, live.id])
  })
})
