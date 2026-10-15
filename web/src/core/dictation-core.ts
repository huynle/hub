// Dictation (the composer's mic button) as one app-level state machine, so a recording always belongs to the
// session it was started in: the transcript goes into that session's draft (never sent, never another
// session's draft). Leaving the session while recording (or while the microphone is still starting) cancels
// it; leaving while transcribing still delivers to the original session's draft. No DOM: the recorder, the
// draft store and notices are injected.

export interface Recording {
  /** Stops and transcribes: the text ("" when nothing was heard). */
  finish(): Promise<string>
  cancel(): void
}

export interface DictationDeps {
  /** Starts recording; `onTick` gets the seconds left. Rejects with a readable message. */
  record(onTick: (secondsLeft: number) => void): Promise<Recording>
  /** Puts dictated text into a session's draft. */
  deliver(sessionID: string, text: string): void
  notify(text: string, kind?: "err" | "warn"): void
  /** Mutes other microphone users (Voice mode elsewhere) while recording; returns the release. */
  hold?(): () => void
}

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing"

export interface DictationState {
  readonly phase: DictationPhase
  readonly sessionID?: string
  readonly secondsLeft?: number
}

export const MAX_DICTATION_SECONDS = 60

export class Dictation {
  state: DictationState = { phase: "idle" }
  private recording: Recording | undefined
  private release: (() => void) | undefined
  /** Bumped by every start and cancel: a stale start or result is dropped. */
  private run = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: DictationDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** What the mic button of `sessionID` shows. */
  forSession(sessionID: string): { recording: false | number; transcribing: boolean } {
    const mine = this.state.sessionID === sessionID
    return {
      recording: mine && (this.state.phase === "recording" || this.state.phase === "starting") ? (this.state.secondsLeft ?? MAX_DICTATION_SECONDS) : false,
      transcribing: mine && this.state.phase === "transcribing",
    }
  }

  /** The mic button in `sessionID`: starts recording, or stops and transcribes a recording made there. */
  async toggle(sessionID: string): Promise<void> {
    const { phase } = this.state
    if (phase === "idle") return this.start(sessionID)
    if (phase === "recording" && this.state.sessionID === sessionID) return this.finish()
  }

  /** The session on screen is now `sessionID`: a recording (or starting one) of another session is cancelled. */
  viewing(sessionID: string | undefined): void {
    const { phase } = this.state
    if ((phase === "recording" || phase === "starting") && this.state.sessionID !== sessionID) this.cancel("Dictation cancelled: you left the session it was for.")
  }

  /** Stops without transcribing. */
  cancel(notice?: string): void {
    if (this.state.phase === "idle") return
    this.run++
    this.recording?.cancel()
    this.recording = undefined
    this.unhold()
    this.set({ phase: "idle" })
    if (notice) this.deps.notify(notice, "warn")
  }

  private async start(sessionID: string): Promise<void> {
    const run = ++this.run
    this.set({ phase: "starting", sessionID, secondsLeft: MAX_DICTATION_SECONDS })
    this.release = this.deps.hold?.()
    let recording: Recording
    try {
      recording = await this.deps.record((secondsLeft) => {
        if (run === this.run && this.state.phase === "recording") this.set({ ...this.state, secondsLeft })
      })
    } catch (e) {
      if (run !== this.run) return
      this.unhold()
      this.set({ phase: "idle" })
      return this.deps.notify(e instanceof Error ? e.message : String(e), "err")
    }
    // Cancelled (e.g. the user left) while the microphone was starting: no orphan recording.
    if (run !== this.run) return recording.cancel()
    this.recording = recording
    this.set({ phase: "recording", sessionID, secondsLeft: MAX_DICTATION_SECONDS })
  }

  private async finish(): Promise<void> {
    const recording = this.recording
    const sessionID = this.state.sessionID
    if (!recording || !sessionID) return
    const run = this.run
    this.recording = undefined
    this.set({ phase: "transcribing", sessionID })
    try {
      const text = (await recording.finish()).trim()
      if (run !== this.run) return
      if (!text) this.deps.notify("Didn't catch that. Try again.", "warn")
      else this.deps.deliver(sessionID, text)
    } catch (e) {
      if (run === this.run) this.deps.notify(e instanceof Error ? e.message : String(e), "err")
    } finally {
      if (run === this.run) {
        this.unhold()
        this.set({ phase: "idle" })
      }
    }
  }

  private unhold(): void {
    const release = this.release
    this.release = undefined
    release?.()
  }

  private set(state: DictationState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }
}
