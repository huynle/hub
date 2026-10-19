// Voice mode as one app-level controller (not per session view): the Voice button toggles Voice mode for a
// session; only one session is in Voice mode at a time, so turning it on elsewhere first turns the current one
// off (its conversation stops: mic released, playback stopped, the hub told {on: false}). Voice mode keeps
// running while the user looks at other sessions; session views attach to show its transcript bubbles and
// notes. Failures leave Voice mode off with the error kept for the session that failed. No DOM: enabling Voice,
// creating conversations and stopping playback are injected.
import type { ConversationState, ConversationUI, Tick } from "../voice/conversation"

/** What the controller needs of a conversation (web/src/voice/conversation.ts implements it). */
export interface VoiceConversation {
  readonly sessionID: string
  readonly paused: boolean
  readonly agent: string | undefined
  start(): Promise<boolean>
  stop(options?: { post?: boolean; keepalive?: boolean }): Promise<void>
  pause(): void
  resume(): void
  onEvent(message: Record<string, any>): void
  onStatus(sessions: readonly any[]): void
  sendTyped(text: string): Promise<void>
}

/** A mounted session view: shows the conversation's bubbles and notes in its transcript. */
export interface VoiceSink {
  user(text: string): string
  tick(bubble: string, kind: Tick): void
  agent(message: { messageID?: string; text: string }): void
  note(text: string, kind?: string): void
}

export interface VoiceControllerDeps<C extends VoiceConversation> {
  /** Turns Voice on for the session if needed; false when that failed (already reported). */
  expose(sessionID: string): Promise<boolean>
  create(sessionID: string, ui: ConversationUI<string>): C
  /** Stops any reply being read aloud. */
  stopPlayback(): void
  notify(text: string, kind?: string): void
}

export type VoicePhase = "off" | "starting" | "on"

export interface VoiceState {
  readonly phase: VoicePhase
  /** The session in Voice mode (or starting it). */
  readonly sessionID?: string
  readonly voice: ConversationState
  readonly level: number
  readonly held: string
  readonly paused: boolean
  readonly agent?: string
  /** The last turn's timing: "last turn: 1.8 s to first audio" and its steps. */
  readonly timing?: { readonly summary: string; readonly detail: string }
  /** The last failure to turn Voice mode on, for the session it was for; `gesture`: the browser waits for a tap. */
  readonly error?: { readonly sessionID: string; readonly message: string; readonly gesture?: boolean }
}

const OFF: VoiceState = { phase: "off", voice: "off", level: 0, held: "", paused: false }

export class VoiceController<C extends VoiceConversation = VoiceConversation> {
  state: VoiceState = OFF
  private conversation: C | undefined
  /** Bumped by every start and stop: callbacks and awaits of an older run are ignored. */
  private run = 0
  private readonly sinks = new Map<string, VoiceSink>()
  private readonly listeners = new Set<() => void>()
  private bubbles = 0

  constructor(private readonly deps: VoiceControllerDeps<C>) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Voice mode is on (or starting) for `sessionID`. */
  isOn(sessionID: string): boolean {
    return this.state.phase !== "off" && this.state.sessionID === sessionID
  }

  errorFor(sessionID: string): string | undefined {
    return this.state.error?.sessionID === sessionID ? this.state.error.message : undefined
  }

  /** Starting Voice mode for `sessionID` failed only for want of a tap (e.g. opened from a link). */
  needsTap(sessionID: string): boolean {
    return this.state.error?.sessionID === sessionID && this.state.error.gesture === true
  }

  /** The Voice button of `sessionID`. */
  toggle(sessionID: string): Promise<void> {
    return this.isOn(sessionID) ? this.stop() : this.start(sessionID)
  }

  /** The Voice bar's End: the same as toggling off. */
  end(): Promise<void> {
    return this.stop()
  }

  async start(sessionID: string): Promise<void> {
    if (this.isOn(sessionID)) return
    // One session at a time: the current one goes off first.
    if (this.state.phase !== "off") await this.stop()
    const run = ++this.run
    let failure = ""
    let gesture = false
    this.set({ ...OFF, phase: "starting", sessionID, voice: "starting" })
    const exposed = await this.deps.expose(sessionID)
    if (run !== this.run) return
    if (!exposed) return this.set({ ...OFF, error: { sessionID, message: "Could not turn Voice on for this session." } })
    const conversation = this.deps.create(sessionID, {
      state: (voice) => run === this.run && this.set({ ...this.state, voice, paused: voice === "paused" }),
      level: (level) => run === this.run && this.set({ ...this.state, level }),
      held: (held) => run === this.run && this.set({ ...this.state, held }),
      timing: (timing) => run === this.run && this.set({ ...this.state, timing }),
      user: (text) => this.sinks.get(sessionID)?.user(text) ?? `voice:${++this.bubbles}`,
      tick: (bubble, kind) => this.sinks.get(sessionID)?.tick(bubble, kind),
      agent: (message) => this.sinks.get(sessionID)?.agent(message),
      note: (text, kind) => {
        // A failure to start is kept as the session's error (shown by its view) rather than repeated as a note.
        if ((kind === "err" || kind === "gesture") && run === this.run && this.state.phase === "starting") {
          failure = text
          gesture = kind === "gesture"
          return
        }
        const sink = this.sinks.get(sessionID)
        if (sink) sink.note(text, kind)
        else this.deps.notify(text, kind)
      },
      ended: () => {
        // The conversation ended itself (the hub turned it off, "pause listening", an error). While it is still
        // starting, start() sees the failed start and keeps the reason.
        if (run !== this.run || this.conversation !== conversation || this.state.phase === "starting") return
        this.run++
        this.conversation = undefined
        this.set(OFF)
      },
    })
    this.conversation = conversation
    const started = await conversation.start()
    // Stopped or switched while starting: stop() already stopped this conversation.
    if (run !== this.run) return
    if (!started) {
      this.run++
      this.conversation = undefined
      return this.set({ ...OFF, error: { sessionID, message: failure || "Could not start Voice mode.", ...(gesture ? { gesture } : {}) } })
    }
    this.set({ ...this.state, phase: "on", agent: conversation.agent })
  }

  /** Turns Voice mode off: stops the conversation (mic, hub flag) and any reply being read aloud. */
  async stop(options: { keepalive?: boolean } = {}): Promise<void> {
    this.run++
    const conversation = this.conversation
    this.conversation = undefined
    if (this.state.phase !== "off") this.set(OFF)
    this.deps.stopPlayback()
    await conversation?.stop(options.keepalive ? { keepalive: true } : undefined)
  }

  /** Mute / unmute the active conversation. */
  mute(): void {
    const c = this.conversation
    if (!c) return
    if (c.paused) c.resume()
    else c.pause()
    this.set({ ...this.state, paused: c.paused })
  }

  /** Mutes Voice mode while something else uses the microphone (dictation); the release unmutes it. */
  hold(): () => void {
    const c = this.conversation
    if (!c || c.paused) return () => {}
    c.pause()
    this.set({ ...this.state, paused: true })
    return () => {
      if (this.conversation !== c || !c.paused) return
      c.resume()
      this.set({ ...this.state, paused: false })
    }
  }

  /** Typed text in the session in Voice mode goes the way of speech; false when that session is not in Voice mode. */
  async sendTyped(sessionID: string, text: string): Promise<boolean> {
    const c = this.conversation
    if (!c || c.sessionID !== sessionID || this.state.phase !== "on") return false
    await c.sendTyped(text)
    return true
  }

  /** Hub SSE messages (say, heard, conversation) of the session in Voice mode. */
  onEvent(message: Record<string, any>): void {
    if (this.conversation && message.sessionID === this.conversation.sessionID) this.conversation.onEvent(message)
  }

  /** Status trees of the session in Voice mode (progress cues). */
  onStatus(sessionID: string, sessions: readonly any[]): void {
    if (this.conversation?.sessionID === sessionID) this.conversation.onStatus(sessions)
  }

  /** A session view on screen; returns the detach. Detaching never stops Voice mode. */
  attach(sessionID: string, sink: VoiceSink): () => void {
    this.sinks.set(sessionID, sink)
    return () => {
      if (this.sinks.get(sessionID) === sink) this.sinks.delete(sessionID)
    }
  }

  private set(state: VoiceState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }
}
