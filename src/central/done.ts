// "All done": one notification when a root session and its whole tree settle, instead of one per root turn.
//
// In OpenCode v2 a root session runs many short turns: each background subagent that completes injects a synthetic
// message into its parent, which starts a new turn, and Voice mode and steering do the same. A notification per
// `session.execution.succeeded` of the root therefore fired while other subagents and jobs were still running.
// A run is armed when anything in the tree starts; once the root's last turn succeeded and the tree is settled
// (StatusBoard.settled: nothing runs, waits for an answer or has a running shell; no hub turn) for DONE_SETTLE_MS
// without anything starting again, it fires once and disarms.
import type { Timers } from "./registry"

/** How long a tree must stay settled before "all done" (a continuation turn starts well within it). */
export const DONE_SETTLE_MS = 15_000

/** Root runs tracked at once (oldest idle ones are forgotten first). */
const RUNS_LIMIT = 1000

type Outcome = "succeeded" | "failed" | "interrupted"

interface Run {
  /** Something ran since the last "all done". */
  armed: boolean
  /** How the root's last turn ended (undefined while it runs). */
  outcome?: Outcome
  timer?: unknown
}

export class DoneWatch {
  private readonly runs = new Map<string, Run>()

  constructor(
    private readonly timers: Timers,
    /** The tree of `rootID` is settled now. */
    private readonly settled: (rootID: string) => boolean,
    private readonly fire: (rootID: string) => void,
    private readonly delay = DONE_SETTLE_MS,
  ) {}

  /** A session of the tree started a run (`root`: the root itself). */
  started(rootID: string, root: boolean): void {
    const run = this.run(rootID)
    run.armed = true
    if (root) run.outcome = undefined
    this.cancel(run)
  }

  /** The root's turn ended; `wasRunning`: it was known to run (a duplicate or stray end does not arm). */
  rootEnded(rootID: string, outcome: Outcome, wasRunning: boolean): void {
    const run = this.runs.get(rootID) ?? (wasRunning ? this.run(rootID) : undefined)
    if (!run) return
    if (wasRunning) run.armed = true
    run.outcome = outcome
    this.schedule(rootID, run)
  }

  /** Something else changed in the tree (a subagent or job ended, an answer, a hub turn released). */
  poke(rootID: string): void {
    const run = this.runs.get(rootID)
    if (run?.armed) this.schedule(rootID, run)
  }

  forget(rootID: string): void {
    const run = this.runs.get(rootID)
    if (run) this.cancel(run)
    this.runs.delete(rootID)
  }

  private run(rootID: string): Run {
    let run = this.runs.get(rootID)
    if (run) return run
    this.runs.set(rootID, (run = { armed: false }))
    if (this.runs.size > RUNS_LIMIT) {
      for (const [id, old] of this.runs) {
        if (old.timer !== undefined) continue
        this.runs.delete(id)
        break
      }
    }
    return run
  }

  private schedule(rootID: string, run: Run): void {
    if (!run.armed) return
    this.cancel(run)
    run.timer = this.timers.set(() => {
      run.timer = undefined
      if (!run.armed || run.outcome !== "succeeded" || !this.settled(rootID)) return
      run.armed = false
      this.fire(rootID)
    }, this.delay)
  }

  private cancel(run: Run): void {
    if (run.timer !== undefined) this.timers.clear(run.timer)
    run.timer = undefined
  }
}
