// Bounded launch verification: the optional last step of a launch-node setup (launch-session). Through an injected
// LaunchDriver (HBS-13 wires it to the hub's launch API and the node's state; tests use a fake), it
//   1. launches one session of the harness in a configured workspace, bounded by maxDurationS,
//   2. waits for the session's response,
//   3. waits for it to end idle,
//   4. checks the workspace holds no launch artifacts afterwards,
//   5. cleans up, and
//   6. checks the node's slot is free again.
// A failure, the user's cancel or the deadline stops it and recovers: cancel the launch, clean up, and check the
// slot. The report lists each stage; its messages are one line, bounded, and never carry a credential (anything
// credential-shaped from the driver is redacted).
import { HARNESS_ORDER, isAbsolutePath, isSecretValue, type ErrorCode, type HarnessID } from "../../contracts/index.ts"
import type { ActionExecutor } from "../../transaction/executor.ts"
import { txFail, txOk, type TxResult } from "../../transaction/result.ts"

export interface LaunchRequest {
  readonly harness: HarnessID
  /** The workspace as the node sees it (absolute, inside a workspace root). */
  readonly workspace: string
  readonly maxDurationS: number
}

/** The launch operations the verification needs; every wait takes the abort signal of the bound. */
export interface LaunchDriver {
  start(request: LaunchRequest, signal: AbortSignal): Promise<TxResult<{ readonly launchID: string }>>
  awaitResponse(launchID: string, signal: AbortSignal): Promise<TxResult<void>>
  awaitIdle(launchID: string, signal: AbortSignal): Promise<TxResult<void>>
  /** What the launch left in the workspace that should not be there (relative names). */
  inspect(launchID: string): Promise<TxResult<{ readonly leftovers: readonly string[] }>>
  cleanup(launchID: string): Promise<TxResult<void>>
  cancel(launchID: string): Promise<TxResult<void>>
  /** Whether the node's slot for this launch is free again. */
  slotFree(launchID: string): Promise<TxResult<boolean>>
}

export interface LaunchTimer {
  after(ms: number): { readonly promise: Promise<void>; cancel(): void }
}

export const realTimer: LaunchTimer = {
  after(ms) {
    let handle: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms)
    })
    return { promise, cancel: () => clearTimeout(handle) }
  },
}

export type LaunchStage = "launch" | "response" | "idle" | "artifacts" | "cleanup" | "slot" | "recover"

export interface StageResult {
  readonly stage: LaunchStage
  readonly ok: boolean
  readonly detail?: string
}

export interface LaunchReport {
  readonly ok: boolean
  readonly launchID?: string
  readonly stages: readonly StageResult[]
  /** After a failure with a launch: whether cancel, cleanup and the slot check all succeeded. */
  readonly recovered?: boolean
  readonly code?: ErrorCode
  readonly message?: string
}

export interface VerifyOptions {
  readonly timer?: LaunchTimer
  /** The user's cancel (Ctrl-C). */
  readonly signal?: AbortSignal
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g

/** One bounded, credential-free line from a driver message. */
export function scrub(text: string): string {
  const words = text
    .replace(CONTROL, " ")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .split(/(\s+)/)
    .map((w) => (isSecretValue(w) ? "[redacted]" : w))
    .join("")
  const line = words.length > 300 ? `${words.slice(0, 297)}...` : words
  return isSecretValue(line) ? "(details withheld)" : line
}

const ABORTED = Symbol("aborted")

/** Runs the bounded verification. Never throws for a driver failure: everything ends in the report. */
export async function verifyLaunch(driver: LaunchDriver, request: LaunchRequest, options: VerifyOptions = {}): Promise<LaunchReport> {
  if (!HARNESS_ORDER.includes(request.harness) || !isAbsolutePath(request.workspace) || !Number.isInteger(request.maxDurationS) || request.maxDurationS < 1 || request.maxDurationS > 86_400)
    return { ok: false, stages: [], code: "invalid", message: "a verification launch needs a known harness, an absolute workspace and a bound of 1 s to 24 h" }
  if (options.signal?.aborted) return { ok: false, stages: [], code: "cancelled", message: "cancelled before the launch" }

  const stages: StageResult[] = []
  const controller = new AbortController()
  let reason: "cancelled" | "timeout" | undefined
  const stop = (why: "cancelled" | "timeout") => {
    reason ??= why
    controller.abort()
  }
  const deadline = (options.timer ?? realTimer).after(request.maxDurationS * 1000)
  void deadline.promise.then(() => stop("timeout"))
  const onCancel = () => stop("cancelled")
  options.signal?.addEventListener("abort", onCancel)
  const aborted = new Promise<typeof ABORTED>((resolve) => controller.signal.addEventListener("abort", () => resolve(ABORTED)))
  const race = <T>(p: Promise<T>) => Promise.race([p, aborted])

  const stopped = () =>
    reason === "cancelled"
      ? { code: "cancelled" as const, message: "the verification launch was cancelled" }
      : { code: "harness_not_ready" as const, message: `the verification launch did not finish within ${request.maxDurationS} s` }
  const failure = (r: { readonly message: string }) => ({ code: "harness_not_ready" as const, message: scrub(r.message) })

  try {
    const started = await race(driver.start(request, controller.signal))
    if (started === ABORTED || !started.ok) {
      const why = started === ABORTED ? stopped() : failure(started)
      stages.push({ stage: "launch", ok: false, detail: why.message })
      return { ok: false, stages, ...why }
    }
    const launchID = started.value.launchID
    stages.push({ stage: "launch", ok: true })

    const fail = async (stage: LaunchStage, why: { code: ErrorCode; message: string }): Promise<LaunchReport> => {
      stages.push({ stage, ok: false, detail: why.message })
      const recovered = await recover(driver, launchID)
      stages.push({ stage: "recover", ok: recovered.ok, ...(recovered.ok ? {} : { detail: recovered.detail }) })
      const message = recovered.ok ? why.message : `${why.message}; recovery failed (${recovered.detail}): launch ${launchID} may still hold its slot and workspace`
      return { ok: false, launchID, stages, recovered: recovered.ok, code: why.code, message }
    }

    for (const [stage, wait] of [
      ["response", () => driver.awaitResponse(launchID, controller.signal)],
      ["idle", () => driver.awaitIdle(launchID, controller.signal)],
    ] as const) {
      const r = await race(wait())
      if (r === ABORTED) return fail(stage, stopped())
      if (!r.ok) return fail(stage, failure(r))
      stages.push({ stage, ok: true })
    }

    const inspected = await driver.inspect(launchID)
    if (!inspected.ok) return fail("artifacts", failure(inspected))
    if (inspected.value.leftovers.length > 0) {
      const names = inspected.value.leftovers.slice(0, 5).map(scrub).join(", ")
      return fail("artifacts", { code: "harness_not_ready", message: `the launch left ${inspected.value.leftovers.length} artifacts behind (${names})` })
    }
    stages.push({ stage: "artifacts", ok: true })

    const cleaned = await driver.cleanup(launchID)
    if (!cleaned.ok) return fail("cleanup", failure(cleaned))
    stages.push({ stage: "cleanup", ok: true })

    const free = await driver.slotFree(launchID)
    if (!free.ok || !free.value) {
      const message = `the node's slot is still held by launch ${launchID}${free.ok ? "" : ` (${scrub(free.message)})`}`
      stages.push({ stage: "slot", ok: false, detail: message })
      return { ok: false, launchID, stages, code: "harness_not_ready", message }
    }
    stages.push({ stage: "slot", ok: true })
    return { ok: true, launchID, stages }
  } finally {
    deadline.cancel()
    options.signal?.removeEventListener("abort", onCancel)
  }
}

/** Cancel, clean up and check the slot; every step runs even when an earlier one failed. */
async function recover(driver: LaunchDriver, launchID: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const problems: string[] = []
  const settle = async <T>(what: string, p: Promise<TxResult<T>>): Promise<TxResult<T> | undefined> => {
    try {
      const r = await p
      if (!r.ok) problems.push(`${what}: ${scrub(r.message)}`)
      return r
    } catch (error) {
      problems.push(`${what}: ${scrub((error as Error).message)}`)
      return undefined
    }
  }
  await settle("cancel", driver.cancel(launchID))
  await settle("cleanup", driver.cleanup(launchID))
  const free = await settle("slot", driver.slotFree(launchID))
  if (free?.ok && !free.value) problems.push("slot: still held")
  return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join("; ") }
}

export interface LaunchProbe {
  readonly driver: LaunchDriver
  readonly timer?: LaunchTimer
  readonly signal?: AbortSignal
  /** Receives every report (the CLI prints its stages). */
  readonly onReport?: (report: LaunchReport) => void
}

/**
 * launch-session: the bounded verification as an external effect. It recovers by itself, so it has no undo; a
 * failure fails the step and the applier rolls back what came before (an activation, a unit).
 */
export function launchSessionExecutor(probe?: LaunchProbe): ActionExecutor<"launch-session"> {
  const missing = () => txFail("internal", "this hubctl was built without a launch driver")
  return {
    kind: "launch-session",
    plan: () => ({ class: "external" }),
    check: async () => (probe ? txOk(undefined) : missing()),
    change: async (action, ctx) => {
      if (!probe) return missing()
      const workspace = ctx.resolve(action.workspace)
      if (!workspace.ok) return workspace
      return txOk({
        type: "effect",
        perform: async () => {
          const report = await verifyLaunch(probe.driver, { harness: action.harness, workspace: workspace.value, maxDurationS: action.maxDurationS }, { timer: probe.timer, signal: probe.signal })
          probe.onReport?.(report)
          return report.ok ? txOk(undefined) : txFail(report.code ?? "harness_not_ready", report.message ?? "the verification launch failed")
        },
      })
    },
  }
}
