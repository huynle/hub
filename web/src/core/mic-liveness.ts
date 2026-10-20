// Is Voice mode really listening? Android Chrome stops or mutes the microphone when the screen turns off or the
// page goes to the background (the track is muted or ended, the AudioContext is suspended, the worklet stops
// sending frames), while everything else (the notification, the silent loop) keeps going. This state machine
// follows those signals: any of them → lost (Voice mode says "paused" instead of "listening"); live again only
// once a frame arrives with nothing blocking — never claims listening without audio. No DOM: the conversation
// (web/src/voice/conversation.ts) feeds it events and the clock.

/** Longest silence from the audio tap (no frames at all, not quiet frames) before listening counts as stopped. */
export const FRAME_GAP_MS = 1500

/** Why listening stopped, most specific first: the track ended, was muted, the audio graph is suspended, or no frames. */
export type LossReason = "ended" | "muted" | "suspended" | "frames"

const RECOVERY_BASE_MS = 500
const RECOVERY_MAX_MS = 8000

/** Delay before the `attempt`th (0-based) retry to bring the microphone back while the page is visible. */
export const recoveryDelay = (attempt: number): number => Math.min(RECOVERY_MAX_MS, RECOVERY_BASE_MS * 2 ** Math.max(0, attempt))

export interface MicLivenessOptions {
  gapMs?: number
  /** Called when listening stops (with the reason) or comes back. */
  onChange?: (live: boolean, reason?: LossReason) => void
}

export class MicLiveness {
  live = true
  private lastFrame = 0
  private isMuted = false
  private isEnded = false
  private suspended = false
  private visible = true
  private readonly gapMs: number

  constructor(private readonly options: MicLivenessOptions = {}) {
    this.gapMs = options.gapMs ?? FRAME_GAP_MS
  }

  /** The current track ended: only a new microphone (getUserMedia) brings listening back. */
  get needsMic(): boolean {
    return this.isEnded
  }

  /** Listening stopped while the page is visible: worth trying to resume now. */
  get wantsRecovery(): boolean {
    return !this.live && this.visible
  }

  get reason(): LossReason | undefined {
    if (this.live) return undefined
    if (this.isEnded) return "ended"
    if (this.isMuted) return "muted"
    if (this.suspended) return "suspended"
    return "frames"
  }

  /** A new Voice mode run: live, nothing blocking, the gap measured from now. */
  start(now: number): void {
    this.live = true
    this.isMuted = this.isEnded = this.suspended = false
    this.lastFrame = now
  }

  /** A frame from the audio tap (silence counts: it proves the graph runs). */
  frame(now: number): void {
    this.lastFrame = now
    if (!this.live && !this.blocked()) this.set(true)
  }

  /** Periodic check: no frames for longer than the gap → lost. */
  tick(now: number): void {
    if (this.live && now - this.lastFrame > this.gapMs) {
      this.set(false)
    }
  }

  /** The track's mute / unmute events (the browser stopped feeding it, e.g. screen off). */
  muted(on: boolean, _now: number): void {
    this.isMuted = on
    if (on) this.lose()
  }

  /** The track's ended event. */
  ended(_now: number): void {
    this.isEnded = true
    this.lose()
  }

  /** A new microphone track replaced the ended one; listening resumes with its first frame. */
  replaced(_now: number): void {
    this.isEnded = this.isMuted = false
  }

  /** The AudioContext's state ("running", "suspended", "interrupted" on Safari, "closed"). */
  audio(state: string, _now: number): void {
    this.suspended = state !== "running"
    if (this.suspended) this.lose()
  }

  visibility(visible: boolean, _now: number): void {
    this.visible = visible
  }

  private blocked(): boolean {
    return this.isEnded || this.isMuted || this.suspended
  }

  private lose(): void {
    if (this.live) this.set(false)
  }

  private set(live: boolean): void {
    this.live = live
    this.options.onChange?.(live, this.reason)
  }
}
