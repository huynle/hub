// Tracks when a prompt we submitted has been fully handled.
//
// OpenCode reports a prompt's lifecycle as: session.inbox.delivered { inboxID } followed by
// session.execution.{succeeded|failed|interrupted} for that session. session.wait() can return
// before delivery, so it cannot be used to wait for the reply.

export type TurnResult =
  | { outcome: "succeeded" }
  | { outcome: "failed" | "interrupted"; message: string }
  | { outcome: "timeout" }

interface EventLike {
  readonly type: string
  readonly data?: unknown
}

const ENDINGS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

export class TurnTracker {
  private readonly pending = new Map<string, Set<string>>()
  private readonly finished = new Map<string, TurnResult>()
  private readonly waiters = new Map<string, Set<(result: TurnResult) => void>>()
  private readonly historyLimit: number

  constructor(options: { historyLimit?: number } = {}) {
    this.historyLimit = options.historyLimit ?? 200
  }

  observe(event: EventLike): void {
    const data = (event.data ?? {}) as Record<string, unknown>
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return

    if (event.type === "session.inbox.delivered" && typeof data.inboxID === "string") {
      const ids = this.pending.get(sessionID) ?? new Set<string>()
      ids.add(data.inboxID)
      this.pending.set(sessionID, ids)
      return
    }

    if (!ENDINGS.has(event.type)) return
    const ids = this.pending.get(sessionID)
    if (!ids) return
    this.pending.delete(sessionID)
    const result = resultOf(event.type, data)
    for (const id of ids) this.finish(id, result)
  }

  wait(inboxID: string, options: { timeoutMs?: number } = {}): Promise<TurnResult> {
    const done = this.finished.get(inboxID)
    if (done) return Promise.resolve(done)
    return new Promise((resolve) => {
      const waiters = this.waiters.get(inboxID) ?? new Set()
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              waiters.delete(settle)
              resolve({ outcome: "timeout" })
            }, options.timeoutMs)
      const settle = (result: TurnResult) => {
        if (timer) clearTimeout(timer)
        resolve(result)
      }
      waiters.add(settle)
      this.waiters.set(inboxID, waiters)
    })
  }

  finishedCount(): number {
    return this.finished.size
  }

  private finish(inboxID: string, result: TurnResult): void {
    this.finished.set(inboxID, result)
    while (this.finished.size > this.historyLimit) {
      const oldest = this.finished.keys().next().value
      if (oldest === undefined) break
      this.finished.delete(oldest)
    }
    const waiters = this.waiters.get(inboxID)
    this.waiters.delete(inboxID)
    for (const settle of waiters ?? []) settle(result)
  }
}

function resultOf(type: string, data: Record<string, unknown>): TurnResult {
  if (type === "session.execution.succeeded") return { outcome: "succeeded" }
  if (type === "session.execution.interrupted") {
    return { outcome: "interrupted", message: String(data.reason ?? "interrupted") }
  }
  const error = data.error as { message?: unknown } | undefined
  return { outcome: "failed", message: String(error?.message ?? "execution failed") }
}
