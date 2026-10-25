// The shared action executor (design §5, §11.4): answering permissions and forms, prompting (steer while the tree
// runs, else a locked turn) and stopping a session. The console routes and the agent act verbs both run these;
// each returns an outcome (done, gone, offline; mode steer|turn) instead of an HTTP response. Fake registry and
// spokes record every call.
import { describe, expect, test } from "bun:test"
import { createActions, type ActionRegistry, type ActionSpokes } from "../src/central/actions"
import { MemoryKv } from "../src/central/backend/memory-kv"
import { MemoryLocks } from "../src/central/backend/memory-counters"
import type { Kv, Locks } from "../src/central/backend/types"
import { BusyError } from "../src/central/registry"
import type { TurnResult } from "../src/protocol"

type Req = { op: string; sessionID: string; [key: string]: unknown }

function fakes(options: {
  permissionTargets?: Array<{ connID: string; sessionID: string }>
  formTargets?: Array<{ connID: string; sessionID: string }>
  owner?: string
  running?: boolean
  exposed?: boolean
  busy?: boolean
  reply?: (connID: string, req: Req) => unknown
  /** Shared with another executor (another pod). */
  kv?: Kv
  /** The cluster's turn locks, shared with another executor (another pod). */
  turnLocks?: Locks
  pod?: string
} = {}) {
  const requests: Array<{ connID: string; req: Req }> = []
  const calls: string[] = []
  const locks: Array<{ sessionID: string; onCancel?: () => void; released: boolean }> = []
  const registry: ActionRegistry = {
    permissionTargets: (rootID, requestID) => (calls.push(`permissionTargets ${rootID} ${requestID}`), options.permissionTargets ?? []),
    dropPermission: (requestID) => void calls.push(`dropPermission ${requestID}`),
    formTargets: (rootID, formID) => (calls.push(`formTargets ${rootID} ${formID}`), options.formTargets ?? []),
    dropForm: (formID) => void calls.push(`dropForm ${formID}`),
    owner: () => options.owner,
    running: () => options.running ?? false,
    exposed: () => options.exposed,
    beginTurn: (sessionID, onCancel) => {
      if (options.busy) throw new BusyError()
      const lock = { sessionID, onCancel, released: false }
      locks.push(lock)
      return () => void (lock.released = true)
    },
    cancelTurns: (sessionID) => {
      calls.push(`cancelTurns ${sessionID}`)
      for (const lock of locks) if (lock.sessionID === sessionID) lock.onCancel?.()
    },
  }
  const spokes: ActionSpokes = {
    request: (async (connID: string, req: Req) => {
      requests.push({ connID, req })
      return options.reply ? options.reply(connID, req) : {}
    }) as ActionSpokes["request"],
  }
  const hops: string[] = []
  const actions = createActions({
    registry,
    spokes,
    humanTurn: async (sessionID) => void hops.push(sessionID),
    ...(options.kv ? { kv: options.kv } : {}),
    ...(options.turnLocks ? { turns: { locks: options.turnLocks, owner: options.pod ?? "pod", ttlMs: 60_000 } } : {}),
  })
  return { actions, requests, calls, locks, hops }
}

describe("answerPermission", () => {
  test("a request not pending in the tree is gone, without asking any spoke", async () => {
    const { actions, requests } = fakes()
    expect(await actions.answerPermission({ rootID: "root", requestID: "per_1", decision: "once" })).toEqual({ outcome: "gone" })
    expect(requests).toEqual([])
  })

  test("tries every process that saw the request until one holds it", async () => {
    const { actions, requests, calls } = fakes({
      permissionTargets: [{ connID: "c1", sessionID: "child" }, { connID: "c2", sessionID: "child" }],
      reply: (connID) => (connID === "c1" ? { gone: true } : {}),
    })
    expect(await actions.answerPermission({ rootID: "root", requestID: "per_1", decision: "reject" })).toEqual({ outcome: "done" })
    expect(requests).toEqual([
      { connID: "c1", req: { op: "permission", sessionID: "child", requestID: "per_1", decision: "reject" } },
      { connID: "c2", req: { op: "permission", sessionID: "child", requestID: "per_1", decision: "reject" } },
    ])
    expect(calls).not.toContain("dropPermission per_1")
  })

  test("a request answered through the hub is gone for a second answer, even if the harness never reports the reply", async () => {
    const { actions, requests } = fakes({ permissionTargets: [{ connID: "c1", sessionID: "s" }], reply: () => ({}) })
    expect(await actions.answerPermission({ rootID: "s", requestID: "per_9", decision: "once" })).toEqual({ outcome: "done" })
    expect(await actions.answerPermission({ rootID: "s", requestID: "per_9", decision: "once" })).toEqual({ outcome: "gone" })
    expect(requests).toHaveLength(1)
  })

  test("no process holds it any more: the blocker is dropped and the answer is gone", async () => {
    const { actions, calls } = fakes({
      permissionTargets: [{ connID: "c1", sessionID: "s" }],
      reply: () => {
        throw new Error("Permission request not found")
      },
    })
    expect(await actions.answerPermission({ rootID: "s", requestID: "per_1", decision: "always" })).toEqual({ outcome: "gone" })
    expect(calls).toContain("dropPermission per_1")
  })

  test("a real spoke failure is thrown when no process took the answer", async () => {
    const { actions, calls } = fakes({
      permissionTargets: [{ connID: "c1", sessionID: "s" }],
      reply: () => {
        throw new Error("boom")
      },
    })
    await expect(actions.answerPermission({ rootID: "s", requestID: "per_1", decision: "once" })).rejects.toThrow("boom")
    expect(calls).not.toContain("dropPermission per_1")
  })
})

// Cluster mode (P6-T8): "answered through the hub" is a Kv key (SET NX PX, 10 minutes), so a request answered on
// one pod is gone on every other, and two pods racing to answer never both send it.
describe("answerPermission on a shared Kv (two pods)", () => {
  const target = { permissionTargets: [{ connID: "c1", sessionID: "s" }], reply: () => ({}) }

  test("a request answered on A is gone on B without asking a spoke", async () => {
    const kv = new MemoryKv()
    const a = fakes({ ...target, kv })
    const b = fakes({ ...target, kv })
    expect(await a.actions.answerPermission({ rootID: "s", requestID: "per_1", decision: "once" })).toEqual({ outcome: "done" })
    expect(await b.actions.answerPermission({ rootID: "s", requestID: "per_1", decision: "once" })).toEqual({ outcome: "gone" })
    expect(b.requests).toEqual([])
  })

  test("two pods answering at once: one sends it, the other is gone", async () => {
    const kv = new MemoryKv()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const a = fakes({ ...target, kv, reply: () => held.then(() => ({})) })
    const b = fakes({ ...target, kv })
    const first = a.actions.answerPermission({ rootID: "s", requestID: "per_2", decision: "once" })
    expect(await b.actions.answerPermission({ rootID: "s", requestID: "per_2", decision: "reject" })).toEqual({ outcome: "gone" })
    release()
    expect(await first).toEqual({ outcome: "done" })
    expect(b.requests).toEqual([])
  })

  test("an answer that failed leaves the request answerable on any pod", async () => {
    const kv = new MemoryKv()
    const a = fakes({ ...target, kv, reply: () => { throw new Error("boom") } })
    const b = fakes({ ...target, kv })
    await expect(a.actions.answerPermission({ rootID: "s", requestID: "per_3", decision: "once" })).rejects.toThrow("boom")
    expect(await b.actions.answerPermission({ rootID: "s", requestID: "per_3", decision: "once" })).toEqual({ outcome: "done" })
  })

  test("answered for 10 minutes", async () => {
    let t = 0
    const kv = new MemoryKv({ now: () => t })
    const a = fakes({ ...target, kv })
    await a.actions.answerPermission({ rootID: "s", requestID: "per_4", decision: "once" })
    expect(await kv.get("action:answered:per_4")).toBeDefined()
    t += 10 * 60_000
    expect(await kv.get("action:answered:per_4")).toBeUndefined()
  })
})

describe("answerForm", () => {
  test("gone when the form is not pending", async () => {
    const { actions, requests } = fakes()
    expect(await actions.answerForm({ rootID: "r", formID: "f1", cancel: true })).toEqual({ outcome: "gone" })
    expect(requests).toEqual([])
  })

  test("answers through the process that holds it", async () => {
    const { actions, requests } = fakes({ formTargets: [{ connID: "c1", sessionID: "child" }] })
    expect(await actions.answerForm({ rootID: "r", formID: "f1", answer: { color: "red" } })).toEqual({ outcome: "done" })
    expect(requests).toEqual([{ connID: "c1", req: { op: "form", sessionID: "child", formID: "f1", answer: { color: "red" } } }])
  })

  test("cancels; nobody holds it: dropped and gone", async () => {
    const { actions, requests, calls } = fakes({ formTargets: [{ connID: "c1", sessionID: "s" }], reply: () => ({ gone: true }) })
    expect(await actions.answerForm({ rootID: "s", formID: "f1", cancel: true })).toEqual({ outcome: "gone" })
    expect(requests[0]!.req).toEqual({ op: "form", sessionID: "s", formID: "f1", cancel: true })
    expect(calls).toContain("dropForm f1")
  })

  test("any spoke error is thrown when nobody took the answer", async () => {
    const { actions } = fakes({
      formTargets: [{ connID: "c1", sessionID: "s" }],
      reply: () => {
        throw new Error("not found")
      },
    })
    await expect(actions.answerForm({ rootID: "s", formID: "f1", cancel: true })).rejects.toThrow("not found")
  })
})

describe("prompt", () => {
  test("no connected owner: offline, and the hop chain is left alone", async () => {
    const { actions, hops, requests } = fakes()
    expect(await actions.prompt({ sessionID: "s", text: "hi", resetHops: true })).toEqual({ outcome: "offline" })
    expect(hops).toEqual([])
    expect(requests).toEqual([])
  })

  test("while the tree runs the text steers the current work", async () => {
    const images = [{ mime: "image/png" as const, data: "AA==" }]
    const { actions, hops, requests } = fakes({ owner: "c1", running: true, reply: () => ({ inboxID: "in_1" }) })
    expect(await actions.prompt({ sessionID: "s", text: "hi", images, resetHops: true })).toEqual({ outcome: "done", mode: "steer", inboxID: "in_1" })
    expect(hops).toEqual(["s"])
    expect(requests).toEqual([{ connID: "c1", req: { op: "steer", sessionID: "s", text: "hi", images } }])
  })

  test("an agent prompt never resets the hop chain", async () => {
    const { actions, hops } = fakes({ owner: "c1", running: true, reply: () => ({ inboxID: "in_1" }) })
    await actions.prompt({ sessionID: "s", text: "hi", resetHops: false })
    expect(hops).toEqual([])
  })

  test("an idle session starts a locked turn (voice style when exposed), released when it settles", async () => {
    const result: TurnResult = { outcome: "succeeded", reply: "done" }
    const { actions, requests, locks } = fakes({ owner: "c1", exposed: true, reply: () => result })
    const outcome = await actions.prompt({ sessionID: "s", text: "go", resetHops: true })
    if (outcome.outcome !== "done" || outcome.mode !== "turn") throw new Error(`unexpected ${JSON.stringify(outcome)}`)
    expect(requests).toEqual([{ connID: "c1", req: { op: "turn", sessionID: "s", text: "go", voiceStyle: true } }])
    expect(await outcome.result).toEqual(result)
    await Promise.resolve()
    expect(locks.map((l) => l.released)).toEqual([true])
  })

  test("a stop ends a waiting turn at once", async () => {
    const { actions, locks } = fakes({ owner: "c1", reply: (_, req) => (req.op === "turn" ? new Promise(() => {}) : { stopped: ["s"] }) })
    const outcome = await actions.prompt({ sessionID: "s", text: "go", resetHops: true })
    if (outcome.outcome !== "done" || outcome.mode !== "turn") throw new Error("expected a turn")
    expect(await actions.stop("s")).toEqual({ outcome: "done", result: { stopped: ["s"] } })
    expect(await outcome.result).toEqual({ outcome: "interrupted", message: "Stopped", reply: "" })
    await Promise.resolve()
    expect(locks[0]!.released).toBe(true)
  })

  test("two pods prompting the same idle session at once: one turn, the other BusyError; free again once it settles", async () => {
    const turnLocks = new MemoryLocks()
    let finish!: (result: TurnResult) => void
    const turn = new Promise<TurnResult>((resolve) => (finish = resolve))
    const a = fakes({ owner: "c1", reply: () => turn, turnLocks, pod: "pod-a" })
    const b = fakes({ owner: "c1", reply: () => ({ outcome: "succeeded", reply: "b" }), turnLocks, pod: "pod-b" })
    const outcome = await a.actions.prompt({ sessionID: "s", text: "from A", resetHops: false })
    expect(outcome).toMatchObject({ outcome: "done", mode: "turn" })
    await expect(b.actions.prompt({ sessionID: "s", text: "from B", resetHops: false })).rejects.toBeInstanceOf(BusyError)
    expect(b.requests).toEqual([])
    // B's local lock was given back.
    expect(b.locks.map((l) => l.released)).toEqual([true])
    finish({ outcome: "succeeded", reply: "a" })
    if (outcome.outcome !== "done" || outcome.mode !== "turn") throw new Error("expected a turn")
    await outcome.result
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const again = await b.actions.prompt({ sessionID: "s", text: "from B", resetHops: false })
    expect(again).toMatchObject({ outcome: "done", mode: "turn" })
    expect(b.requests).toHaveLength(1)
  })

  test("a busy session throws BusyError", async () => {
    const { actions } = fakes({ owner: "c1", busy: true })
    await expect(actions.prompt({ sessionID: "s", text: "go", resetHops: true })).rejects.toBeInstanceOf(BusyError)
  })
})

describe("stop", () => {
  test("offline without an owner", async () => {
    const { actions, calls } = fakes()
    expect(await actions.stop("s")).toEqual({ outcome: "offline" })
    expect(calls).toEqual([])
  })

  test("stops through the owner and releases the tree's turn locks", async () => {
    const { actions, requests, calls } = fakes({ owner: "c1", reply: () => ({ stopped: ["s", "child"] }) })
    expect(await actions.stop("s")).toEqual({ outcome: "done", result: { stopped: ["s", "child"] } })
    expect(requests).toEqual([{ connID: "c1", req: { op: "stop", sessionID: "s" } }])
    expect(calls).toEqual(["cancelTurns s"])
  })
})

describe("answerPermission message (deny reasons)", () => {
  test("a reject's message goes to every process tried; absent when not given", async () => {
    const { actions, requests } = fakes({
      permissionTargets: [{ connID: "c1", sessionID: "child" }, { connID: "c2", sessionID: "child" }],
      reply: (connID) => (connID === "c1" ? { gone: true } : {}),
    })
    expect(await actions.answerPermission({ rootID: "root", requestID: "per_1", decision: "reject", message: "Denied by @x: no" })).toEqual({ outcome: "done" })
    expect(requests.map((r) => r.req.message)).toEqual(["Denied by @x: no", "Denied by @x: no"])
    await actions.answerPermission({ rootID: "root", requestID: "per_2", decision: "reject" })
    expect("message" in requests[2]!.req).toBe(false)
  })
})
