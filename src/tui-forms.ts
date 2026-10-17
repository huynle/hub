// TUI side of form (question) replies from the hub: a standalone server started by this TUI cannot call its
// own HTTP API (its password stays with the TUI), so its spoke queues the replies and the TUI long-polls
// RPC hub.formActions and carries them out with its client. See Spoke.formActions.

export type RelayedFormAction =
  | { readonly sessionID: string; readonly formID: string; readonly answer: Record<string, unknown> }
  | { readonly sessionID: string; readonly formID: string; readonly cancel: true }

export interface FormRelayOptions {
  /** RPC hub.formActions: waits up to `waitMs` for queued replies. */
  readonly poll: (waitMs: number) => Promise<{ actions?: readonly unknown[] }>
  /** Carries one out (client.session.form.reply / cancel). Errors are logged and skipped. */
  readonly apply: (action: RelayedFormAction) => Promise<unknown>
  readonly waitMs?: number
  /** Pause after a failed poll (no spoke, older server, disconnected). */
  readonly retryMs?: number
}

function action(raw: unknown): RelayedFormAction | undefined {
  const a = raw as Record<string, unknown> | null
  if (!a || typeof a.sessionID !== "string" || typeof a.formID !== "string") return undefined
  if (a.cancel === true) return { sessionID: a.sessionID, formID: a.formID, cancel: true }
  if (typeof a.answer === "object" && a.answer !== null && !Array.isArray(a.answer)) {
    return { sessionID: a.sessionID, formID: a.formID, answer: a.answer as Record<string, unknown> }
  }
  return undefined
}

export class FormRelay {
  private running = false
  private wake?: () => void

  constructor(private readonly options: FormRelayOptions) {}

  /** Polls until stop(); resolves when stopped. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    while (this.running) {
      let actions: readonly unknown[] = []
      try {
        actions = (await this.options.poll(this.options.waitMs ?? 20_000)).actions ?? []
      } catch {
        await this.sleep(this.options.retryMs ?? 10_000)
        continue
      }
      for (const raw of actions) {
        const next = action(raw)
        if (!next) continue
        try {
          await this.options.apply(next)
        } catch (cause) {
          console.error("[hub] could not answer a question from the hub", cause instanceof Error ? cause.message : cause)
        }
      }
    }
  }

  stop(): void {
    this.running = false
    this.wake?.()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      ;(timer as { unref?: () => void }).unref?.()
      const self = this
      function done() {
        clearTimeout(timer)
        self.wake = undefined
        resolve()
      }
      this.wake = done
    })
  }
}
