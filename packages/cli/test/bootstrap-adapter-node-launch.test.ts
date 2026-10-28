// Bounded launch verification for a new launch node, through an injected driver (every test uses a fake): launch
// one bounded session, get a response, see it end idle, confirm it left no artifacts behind, clean up, and see the
// slot freed. A failure, a cancel or the deadline recovers (cancel, clean up, free the slot), and the report never
// carries a credential.
import { describe, expect, test } from "bun:test"
import type { Action } from "../src/bootstrap/contracts/index.ts"
import { launchSessionExecutor, verifyLaunch, type LaunchDriver, type LaunchTimer } from "../src/bootstrap/adapters/node-services/launch.ts"
import { txFail, txOk, type TxResult } from "../src/bootstrap/transaction/result.ts"
import { ACTIONS } from "./bootstrap/fixtures.ts"

const REQUEST = { harness: "opencode" as const, workspace: "/home/dev/projects/demo", maxDurationS: 60 }

/** A scripted driver: each step's outcome can be overridden; `hang` steps wait until aborted. */
class FakeDriver implements LaunchDriver {
  readonly calls: string[] = []
  outcome: Partial<Record<"start" | "awaitResponse" | "awaitIdle" | "cancel" | "cleanup", TxResult<void> | "hang">> = {}
  leftovers: string[] = []
  slotFreed = true
  onAwaitIdle?: () => void

  private async step(name: keyof FakeDriver["outcome"], signal?: AbortSignal): Promise<TxResult<void>> {
    const o = this.outcome[name]
    if (o === "hang") return new Promise(() => signal?.addEventListener("abort", () => undefined))
    return o ?? txOk(undefined)
  }

  async start(request: typeof REQUEST, signal: AbortSignal): Promise<TxResult<{ launchID: string }>> {
    this.calls.push(`start ${request.harness} ${request.workspace} ${request.maxDurationS}`)
    const r = await this.step("start", signal)
    return r.ok ? txOk({ launchID: "lnch_1" }) : r
  }
  async awaitResponse(id: string, signal: AbortSignal) {
    this.calls.push(`response ${id}`)
    return this.step("awaitResponse", signal)
  }
  async awaitIdle(id: string, signal: AbortSignal) {
    this.calls.push(`idle ${id}`)
    this.onAwaitIdle?.()
    return this.step("awaitIdle", signal)
  }
  async inspect(id: string) {
    this.calls.push(`inspect ${id}`)
    return txOk({ leftovers: this.leftovers })
  }
  async cleanup(id: string) {
    this.calls.push(`cleanup ${id}`)
    return this.step("cleanup")
  }
  async cancel(id: string) {
    this.calls.push(`cancel ${id}`)
    return this.step("cancel")
  }
  async slotFree(id: string) {
    this.calls.push(`slot ${id}`)
    return txOk(this.slotFreed)
  }
}

/** A timer that only fires when the test says so. */
class FakeTimer implements LaunchTimer {
  readonly requested: number[] = []
  cancelled = 0
  private fire: (() => void)[] = []
  after(ms: number) {
    this.requested.push(ms)
    return { promise: new Promise<void>((resolve) => this.fire.push(resolve)), cancel: () => void this.cancelled++ }
  }
  expire() {
    for (const f of this.fire) f()
  }
}

const stages = (r: { stages: readonly { stage: string; ok: boolean }[] }) => r.stages.map((s) => `${s.stage}:${s.ok ? "ok" : "failed"}`)

describe("verifyLaunch", () => {
  test("launch, response, idle end, clean artifacts, cleanup, slot freed", async () => {
    const d = new FakeDriver()
    const timer = new FakeTimer()
    const r = await verifyLaunch(d, REQUEST, { timer })
    expect(r.ok).toBe(true)
    expect(stages(r)).toEqual(["launch:ok", "response:ok", "idle:ok", "artifacts:ok", "cleanup:ok", "slot:ok"])
    expect(d.calls).toEqual(["start opencode /home/dev/projects/demo 60", "response lnch_1", "idle lnch_1", "inspect lnch_1", "cleanup lnch_1", "slot lnch_1"])
    expect(r.launchID).toBe("lnch_1")
    expect(timer.requested).toEqual([60_000])
    expect(timer.cancelled).toBe(1)
  })

  test("a launch that never starts has nothing to recover", async () => {
    const d = new FakeDriver()
    d.outcome.start = txFail("offline", "the hub did not place the launch")
    const r = await verifyLaunch(d, REQUEST, { timer: new FakeTimer() })
    expect(r).toMatchObject({ ok: false, code: "harness_not_ready" })
    expect(stages(r)).toEqual(["launch:failed"])
    expect(d.calls).toEqual(["start opencode /home/dev/projects/demo 60"])
  })

  test("no response: cancel, clean up and free the slot", async () => {
    const d = new FakeDriver()
    d.outcome.awaitResponse = txFail("harness_not_ready", "the session never answered")
    const r = await verifyLaunch(d, REQUEST, { timer: new FakeTimer() })
    expect(r).toMatchObject({ ok: false, code: "harness_not_ready", recovered: true })
    expect(stages(r)).toEqual(["launch:ok", "response:failed", "recover:ok"])
    expect(d.calls.slice(2)).toEqual(["cancel lnch_1", "cleanup lnch_1", "slot lnch_1"])
    expect(r.message).toContain("the session never answered")
  })

  test("the user cancels while it runs: cancelled, recovered", async () => {
    const d = new FakeDriver()
    const controller = new AbortController()
    d.outcome.awaitIdle = "hang"
    d.onAwaitIdle = () => controller.abort()
    const r = await verifyLaunch(d, REQUEST, { timer: new FakeTimer(), signal: controller.signal })
    expect(r).toMatchObject({ ok: false, code: "cancelled", recovered: true })
    expect(d.calls.slice(-3)).toEqual(["cancel lnch_1", "cleanup lnch_1", "slot lnch_1"])
  })

  test("the deadline (maxDurationS) ends it: recovered", async () => {
    const d = new FakeDriver()
    const timer = new FakeTimer()
    d.outcome.awaitIdle = "hang"
    d.onAwaitIdle = () => timer.expire()
    const r = await verifyLaunch(d, REQUEST, { timer })
    expect(r).toMatchObject({ ok: false, code: "harness_not_ready", recovered: true })
    expect(r.message).toContain("60 s")
    expect(d.calls).toContain("cancel lnch_1")
  })

  test("an already cancelled request launches nothing", async () => {
    const d = new FakeDriver()
    const controller = new AbortController()
    controller.abort()
    const r = await verifyLaunch(d, REQUEST, { timer: new FakeTimer(), signal: controller.signal })
    expect(r).toMatchObject({ ok: false, code: "cancelled" })
    expect(d.calls).toEqual([])
  })

  test("artifacts left behind fail the check, and are still cleaned up", async () => {
    const d = new FakeDriver()
    d.leftovers = [".hub/launch.lock", "tmp/session.log"]
    const r = await verifyLaunch(d, REQUEST, { timer: new FakeTimer() })
    expect(r.ok).toBe(false)
    expect(stages(r)).toEqual(["launch:ok", "response:ok", "idle:ok", "artifacts:failed", "recover:ok"])
    expect(r.message).toContain("2 artifacts")
    expect(d.calls).toContain("cleanup lnch_1")
  })

  test("a slot that is not freed fails, naming the launch to clean up by hand", async () => {
    const d = new FakeDriver()
    d.slotFreed = false
    const r = await verifyLaunch(d, REQUEST, { timer: new FakeTimer() })
    expect(r).toMatchObject({ ok: false, code: "harness_not_ready" })
    expect(stages(r).at(-1)).toBe("slot:failed")
  })

  test("a recovery that fails says so, with the launch to clean up", async () => {
    const d = new FakeDriver()
    d.outcome.awaitResponse = txFail("harness_not_ready", "no answer")
    d.outcome.cleanup = txFail("internal", "workspace busy")
    const r = await verifyLaunch(d, REQUEST, { timer: new FakeTimer() })
    expect(r).toMatchObject({ ok: false, recovered: false })
    expect(stages(r).at(-1)).toBe("recover:failed")
    expect(r.message).toContain("lnch_1")
  })

  test("diagnostics never carry a credential", async () => {
    const d = new FakeDriver()
    d.outcome.awaitResponse = txFail("unauthorized", "rejected token mt_secretmachinetoken123 for Bearer abc.def")
    const r = await verifyLaunch(d, REQUEST, { timer: new FakeTimer() })
    expect(JSON.stringify(r)).not.toContain("mt_secret")
    expect(JSON.stringify(r)).not.toContain("Bearer abc")
  })

  test("refuses an unbounded or relative request before launching", async () => {
    const d = new FakeDriver()
    for (const bad of [{ ...REQUEST, maxDurationS: 0 }, { ...REQUEST, maxDurationS: 86_401 }, { ...REQUEST, workspace: "projects/demo" }]) {
      const r = await verifyLaunch(d, bad, { timer: new FakeTimer() })
      expect(r).toMatchObject({ ok: false, code: "invalid" })
    }
    expect(d.calls).toEqual([])
  })
})

describe("launch-session executor", () => {
  const action = ACTIONS["launch-session"] as Extract<Action, { kind: "launch-session" }>
  const ctx = { resolve: () => txOk("/home/dev/projects/demo") } as never

  test("an external effect that launches in the resolved workspace and reports", async () => {
    const d = new FakeDriver()
    const reports: unknown[] = []
    const exec = launchSessionExecutor({ driver: d, timer: new FakeTimer(), onReport: (r) => reports.push(r) })
    expect(exec.plan(action)).toEqual({ class: "external" })
    const change = await exec.change(action, ctx)
    if (!change.ok || change.value.type !== "effect") throw new Error("expected an effect")
    expect(await change.value.perform()).toEqual({ ok: true, value: undefined })
    expect(d.calls[0]).toBe("start opencode /home/dev/projects/demo 900")
    expect(reports).toHaveLength(1)
  })

  test("a failed verification fails the step (the applier rolls back what came before)", async () => {
    const d = new FakeDriver()
    d.outcome.awaitIdle = txFail("harness_not_ready", "the session crashed")
    const change = await launchSessionExecutor({ driver: d, timer: new FakeTimer() }).change(action, ctx)
    if (!change.ok || change.value.type !== "effect") throw new Error("expected an effect")
    expect(await change.value.perform()).toMatchObject({ ok: false, code: "harness_not_ready" })
  })

  test("without a driver the step is refused at preflight", async () => {
    const r = await launchSessionExecutor(undefined).check!(action, ctx)
    expect(r).toMatchObject({ ok: false, code: "internal" })
  })
})
