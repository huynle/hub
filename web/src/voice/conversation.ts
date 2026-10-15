// Hands-free conversation mode for one session: always-on mic → energy VAD → speculative per-segment
// transcription → endpointing → POST utterance; SSE "say" text → sentence TTS queue with barge-in.
// Progress cues (earcons, "Working on it." …) are scheduled by feedback-core and played by cues.
// The pure parts live in core/conversation-core; this file owns the browser APIs (mic, Web Audio, wake lock,
// media session). Ported from the 0.4 web/conversation.js; behavior unchanged except the mic device choice.
import { Endpointer, EnergyVad, SpeechQueue, encodeWav, parseCommand, splitSentences } from "../core/conversation-core"
import { CuePlayer } from "../core/cues"
import { CueScheduler, isWorking, subagentChanges, type StatusEntry } from "../core/feedback-core"
import type { ApiInit } from "../app/api"

const SENT_LABEL_MS = 2500
const CUE_TICK_MS = 1000
const SILENCE_SECONDS = 2

export type ConversationState = "starting" | "listening" | "hearing" | "transcribing" | "sent" | "speaking" | "paused" | "off"
export type Tick = "sent" | "heard" | "failed"

export interface ConversationUI<B> {
  state(name: ConversationState): void
  level(x: number): void
  held?(text: string): void
  /** A user utterance bubble; returned handle is passed to `tick`. */
  user(text: string): B
  tick(bubble: B, kind: Tick): void
  agent(message: { messageID?: string; text: string }): void
  note(text: string, kind?: string): void
  ended(): void
}

export interface ConversationOptions {
  cues?: boolean
  background?: boolean
  speed?: () => number
  title?: () => string
  status?: readonly StatusEntry[]
  /** Microphone deviceId ("" or undefined: the default). */
  deviceId?: string
}

type Api = (path: string, init?: ApiInit) => Promise<Response>

export function micConstraints(deviceId?: string): MediaStreamConstraints {
  return { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } }
}

export class Conversation<B = unknown> {
  readonly sessionID: string
  private api: Api
  private player: HTMLAudioElement
  private ui: ConversationUI<B>
  private opts: Required<Omit<ConversationOptions, "status" | "deviceId">> & Pick<ConversationOptions, "deviceId">
  active = false
  paused = false
  agent: string | undefined
  private inflight = 0
  private sent = new Map<string, B | "heard">()
  private heardAt = 0
  private lastStatus: readonly StatusEntry[] | undefined
  private scheduler = new CueScheduler()
  private cuePlayer: CuePlayer
  private onVisibility: () => void
  private stream?: MediaStream
  private ctx?: AudioContext
  private source?: MediaStreamAudioSourceNode
  private sink?: GainNode
  private tap?: AudioWorkletNode | ScriptProcessorNode
  private vad?: EnergyVad
  private endpointer?: Endpointer
  private queue?: SpeechQueue<string>
  private ticker?: ReturnType<typeof setInterval>
  private silence?: HTMLAudioElement
  private silenceURL?: string
  private wakeLock?: WakeLockSentinel
  private warnedAutoplay = false
  private state: ConversationState | undefined
  /** Bumped by start() and stop(); a start that sees another value was cancelled. */
  private attempt = 0

  constructor({ sessionID, api, player, ui, options = {} }: { sessionID: string; api: Api; player: HTMLAudioElement; ui: ConversationUI<B>; options?: ConversationOptions }) {
    this.sessionID = sessionID
    this.api = api
    this.player = player
    this.ui = ui
    this.opts = { cues: true, background: false, speed: () => 1, title: () => "OpenCode session", ...options }
    this.lastStatus = options.status
    this.scheduler.enabled = this.opts.cues !== false
    this.scheduler.working(isWorking(options.status), Date.now())
    this.cuePlayer = new CuePlayer({ api: this.api as never, speed: this.opts.speed, onSpeaking: (on) => this.scheduler.cueSpeaking(on, Date.now()) })
    this.onVisibility = () => {
      if (document.visibilityState === "visible" && this.active && !this.opts.background) void this.lockScreen()
    }
  }

  private get path(): string {
    return `/api/sessions/${encodeURIComponent(this.sessionID)}`
  }

  /** Mic first (a refusal leaves the server untouched), then the server flag. Returns false on failure. */
  async start(): Promise<boolean> {
    if (this.active) return true
    // stop() while starting cancels this start: nothing may keep listening afterwards.
    const attempt = ++this.attempt
    const cancelled = () => attempt !== this.attempt
    this.ui.state("starting")
    this.cuePlayer.unlock() // still inside the tap
    if (this.opts.background) this.startSilence()
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    if (!navigator.mediaDevices?.getUserMedia || !(w.AudioContext || w.webkitAudioContext)) {
      this.ui.note("This browser cannot listen here (the microphone needs HTTPS).", "err")
      this.ui.state("off")
      return false
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(this.opts.deviceId))
    } catch (e) {
      if (cancelled()) return false
      const err = e as Error
      this.ui.note(err.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in the browser's site settings." : `Microphone: ${err.message}`, "err")
      this.ui.state("off")
      this.stopSilence()
      return false
    }
    if (cancelled()) {
      stream.getTracks().forEach((t) => t.stop())
      return false
    }
    this.stream = stream
    try {
      const { agent } = await (await this.api(`${this.path}/conversation`, { method: "POST", json: { on: true } })).json()
      this.agent = agent
    } catch (e) {
      this.release()
      this.stopSilence()
      if (cancelled()) return false
      this.ui.note(`Could not start Voice mode: ${(e as Error).message}`, "err")
      this.ui.state("off")
      return false
    }
    if (cancelled()) {
      // Stopped while the hub was turning conversation mode on: turn it off again.
      this.release()
      await this.api(`${this.path}/conversation`, { method: "POST", json: { on: false } }).catch(() => {})
      return false
    }
    this.active = true
    try {
      await this.listen()
    } catch (e) {
      if (cancelled()) return false
      this.ui.note(`Could not start listening: ${(e as Error).message}`, "err")
      await this.stop()
      return false
    }
    if (cancelled()) return false
    if (this.opts.background) this.mediaSession()
    else void this.lockScreen()
    document.addEventListener("visibilitychange", this.onVisibility)
    this.ticker = setInterval(() => this.tickCues(), CUE_TICK_MS)
    this.refresh()
    return true
  }

  private async listen(): Promise<void> {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const AudioCtx = (w.AudioContext || w.webkitAudioContext)!
    const ctx = (this.ctx = new AudioCtx())
    await ctx.resume().catch(() => {})
    this.source = ctx.createMediaStreamSource(this.stream!)
    this.sink = ctx.createGain()
    this.sink.gain.value = 0 // keeps the tap pulled by the graph without making a sound
    this.sink.connect(ctx.destination)
    if (ctx.audioWorklet && "AudioWorkletNode" in window) {
      await ctx.audioWorklet.addModule("/vad-worklet.js")
      const node = new AudioWorkletNode(ctx, "vad-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
      node.port.onmessage = (event) => this.frame(event.data as Float32Array)
      this.tap = node
    } else {
      const node = ctx.createScriptProcessor(1024, 1, 1)
      node.onaudioprocess = (event) => this.frame(Float32Array.from(event.inputBuffer.getChannelData(0)))
      this.tap = node
    }
    this.source.connect(this.tap)
    this.tap.connect(this.sink)

    this.vad = new EnergyVad({ sampleRate: ctx.sampleRate })
    this.endpointer = new Endpointer({
      send: (text) => void this.deliver(text),
      onHeld: (text) => this.ui.held?.(text),
    })
    this.queue = new SpeechQueue<string>({
      synth: (text, signal) => this.synth(text, signal),
      play: (url) => this.play(url),
      stop: () => {
        if (!this.player.paused) this.player.pause()
      },
      onState: (speaking) => {
        if (this.vad) this.vad.speaking = speaking
        this.scheduler.agentSpeaking(speaking, Date.now())
        if (speaking) this.cuePlayer.stop() // the agent's own speech wins over a cue
        this.refresh()
      },
      onError: (error) => {
        if (error?.name !== "AbortError") this.ui.note(`Could not read the reply aloud: ${error?.message}`, "err")
      },
    })
  }

  /** One ~20 ms frame from the mic. */
  private frame(samples: Float32Array): void {
    if (!this.active || !this.vad || this.paused) return
    const { level, events } = this.vad.process(samples)
    this.ui.level(level)
    for (const event of events) {
      if (event.type === "start") {
        this.endpointer!.speechStarted()
        this.scheduler.userTalking(true, Date.now())
        this.cuePlayer.stop()
        if (this.queue!.speaking) this.queue!.clear() // barge-in: start fires only after 250 ms of voice
      } else {
        this.scheduler.userTalking(false, Date.now())
        const id = this.endpointer!.segmentEnded(event.durationMs)
        void this.transcribe(id, encodeWav(event.samples, this.vad.sampleRate))
      }
      this.refresh()
    }
  }

  private async transcribe(id: number, wav: Uint8Array<ArrayBuffer>): Promise<void> {
    this.inflight++
    this.refresh()
    let text = ""
    try {
      text = (await (await this.api("/api/transcribe", { method: "POST", body: wav, headers: { "content-type": "audio/wav" } })).json()).text ?? ""
    } catch (e) {
      if (this.active) this.ui.note(`Transcription failed: ${(e as Error).message}`, "err")
    } finally {
      this.inflight--
    }
    if (!this.active) return
    this.endpointer?.transcribed(id, text)
    this.refresh()
  }

  /** A finished utterance from the endpointer (or typed text): a voice command or a steer. */
  private async deliver(text: string): Promise<void> {
    const command = parseCommand(text)
    if (command === "pause") {
      this.ui.note("Paused listening.")
      return this.stop()
    }
    if (command === "interrupt") {
      this.queue?.clear()
      this.ui.note(`“${text}” — interrupting.`)
      try {
        await this.api(`${this.path}/interrupt`, { method: "POST", json: {} })
      } catch (e) {
        this.ui.note(`Could not interrupt: ${(e as Error).message}`, "err")
      }
      return
    }
    const bubble = this.ui.user(text)
    try {
      const { inboxID } = await (await this.api(`${this.path}/utterance`, { method: "POST", json: { text } })).json()
      if (this.sent.get(inboxID) === "heard") this.ui.tick(bubble, "heard") // delivery beat the response
      else this.ui.tick(bubble, "sent")
      this.sent.set(inboxID, bubble)
    } catch (e) {
      const err = e as Error & { status?: number }
      this.ui.tick(bubble, "failed")
      this.ui.note(err.status === 409 ? err.message : `Could not send: ${err.message}`, "err")
    }
  }

  /** Typed text while Voice mode is on goes the same way as speech. */
  sendTyped(text: string): Promise<void> {
    this.queue?.clear()
    return this.deliver(text)
  }

  /** Hub SSE messages for this session. */
  onEvent(message: Record<string, any>): void {
    if (message.sessionID !== this.sessionID) return
    if (message.type === "heard") {
      const bubble = this.sent.get(message.inboxID)
      if (bubble !== undefined && bubble !== "heard") this.ui.tick(bubble, "heard")
      else this.sent.set(message.inboxID, "heard")
      this.heardAt = Date.now()
      if (this.active && !this.paused) this.cuePlayer.play(this.scheduler.heard(this.heardAt))
      this.refresh()
      setTimeout(() => this.refresh(), SENT_LABEL_MS + 50)
    } else if (message.type === "say") {
      if (!this.active) return
      this.scheduler.agentSaid(Date.now())
      this.cuePlayer.stop()
      this.ui.agent(message as { messageID?: string; text: string })
      this.queue?.enqueue(splitSentences(message.text))
    } else if (message.type === "conversation" && !message.on && this.active) {
      this.ui.note("Voice mode was turned off.")
      void this.stop({ post: false })
    }
  }

  /** Status tree of this root session: drives "Started a subagent.", the subagent-done earcon and "Still working.". */
  onStatus(sessions: readonly StatusEntry[]): void {
    const now = Date.now()
    const { started, finished } = subagentChanges(this.lastStatus, sessions, this.sessionID)
    this.lastStatus = sessions
    this.scheduler.working(isWorking(sessions), now)
    if (!this.active) return
    for (let i = 0; i < started.length; i++) this.scheduler.subagentStarted(now)
    if (finished.length && !this.paused) this.cuePlayer.play(this.scheduler.subagentFinished(now))
    this.tickCues()
  }

  private tickCues(): void {
    if (!this.active || this.paused) return
    this.cuePlayer.play(this.scheduler.tick(Date.now()))
  }

  setCues(on: boolean): void {
    this.scheduler.enabled = on
    if (!on) this.cuePlayer.stop()
  }

  /** Switches screen-off listening while active: wake lock ↔ media session + silent loop. */
  setBackground(on: boolean): void {
    this.opts.background = on
    if (!this.active) return
    if (on) {
      this.wakeLock?.release().catch(() => {})
      this.wakeLock = undefined
      this.startSilence()
      this.mediaSession()
    } else {
      this.stopSilence()
      this.clearMediaSession()
      void this.lockScreen()
    }
  }

  /** Mute: stop listening (mic muted, speech cleared) but keep the mode on for a quick resume. */
  pause(): void {
    if (!this.active || this.paused) return
    this.paused = true
    this.queue?.clear()
    this.cuePlayer.stop()
    this.endpointer?.reset()
    this.vad?.reset()
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = false))
    this.silence?.pause()
    if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused"
    this.ui.level(0)
    this.refresh()
  }

  resume(): void {
    if (!this.active || !this.paused) return
    this.paused = false
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = true))
    this.ctx?.resume().catch(() => {})
    if (this.opts.background) {
      this.silence?.play().catch(() => {})
      if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing"
    }
    this.refresh()
  }

  /**
   * Lock screen / notification controls (Android Chrome shows them while media plays). The metadata ("Voice
   * mode on", the session title) and the pause/stop → End handlers are app-level (web/src/app/voice.ts); the
   * conversation only reports whether it plays.
   */
  private mediaSession(): void {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = this.paused ? "paused" : "playing"
  }

  private clearMediaSession(): void {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = "none"
  }

  /** A silent looping <audio> while listening with the screen off (keeps the page alive; lock-screen controls). */
  private startSilence(): void {
    if (!this.silence) {
      const url = URL.createObjectURL(new Blob([encodeWav(new Float32Array(16_000 * SILENCE_SECONDS), 16_000)], { type: "audio/wav" }))
      const audio = new Audio(url)
      audio.loop = true
      audio.setAttribute("aria-hidden", "true")
      this.silence = audio
      this.silenceURL = url
    }
    this.silence.play().catch(() => {})
  }

  private stopSilence(): void {
    if (!this.silence) return
    this.silence.pause()
    this.silence.removeAttribute("src")
    this.silence.load()
    if (this.silenceURL) URL.revokeObjectURL(this.silenceURL)
    this.silence = this.silenceURL = undefined
  }

  /** Stops reading aloud; resumes listening when muted. */
  hush(): void {
    if (this.paused) return this.resume()
    this.queue?.clear()
    this.cuePlayer.stop()
  }

  private async synth(text: string, signal: AbortSignal): Promise<string> {
    const res = await this.api("/api/speak", { method: "POST", json: { text }, signal })
    return URL.createObjectURL(await res.blob())
  }

  private async play(url: string): Promise<void> {
    const player = this.player
    try {
      player.src = url
      const played = await player.play().then(
        () => true,
        () => false,
      )
      if (!played) {
        if (!this.warnedAutoplay) this.ui.note("The browser blocked audio playback. Tap the mic to allow it.")
        this.warnedAutoplay = true
        return
      }
      await new Promise<void>((resolve) => {
        player.onended = player.onpause = player.onerror = () => resolve()
      })
    } finally {
      player.onended = player.onpause = player.onerror = null
      URL.revokeObjectURL(url)
    }
  }

  private refresh(): void {
    if (!this.active) return
    const state: ConversationState = this.paused
      ? "paused"
      : this.queue?.speaking
        ? "speaking"
        : this.vad?.active
          ? "hearing"
          : this.inflight > 0 || this.endpointer?.held
            ? "transcribing"
            : Date.now() - this.heardAt < SENT_LABEL_MS
              ? "sent"
              : "listening"
    if (state !== this.state) {
      this.state = state
      this.ui.state(state)
    }
  }

  private async lockScreen(): Promise<void> {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return
    if (this.wakeLock && !this.wakeLock.released) return
    try {
      this.wakeLock = await navigator.wakeLock.request("screen")
    } catch {
      // Battery saver or no permission: the screen may sleep, listening continues while visible.
    }
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = undefined
  }

  /** Turns everything off; `post: false` when the server already did (SSE) or the page is going away. */
  async stop({ post = true, keepalive = false }: { post?: boolean; keepalive?: boolean } = {}): Promise<void> {
    this.attempt++
    const wasActive = this.active
    this.active = false
    this.paused = false
    this.state = undefined
    document.removeEventListener("visibilitychange", this.onVisibility)
    clearInterval(this.ticker)
    this.cuePlayer.close()
    this.stopSilence()
    if (this.opts.background) this.clearMediaSession()
    this.queue?.clear()
    this.endpointer?.reset()
    this.vad?.reset()
    try {
      this.source?.disconnect()
      this.tap?.disconnect()
      if (this.tap && "port" in this.tap) this.tap.port.onmessage = null
      this.sink?.disconnect()
    } catch {
      // already disconnected
    }
    this.ctx?.close().catch(() => {})
    this.ctx = this.source = this.tap = this.sink = this.vad = undefined
    this.release()
    this.wakeLock?.release().catch(() => {})
    this.wakeLock = undefined
    this.ui.level(0)
    this.ui.held?.("")
    this.ui.state("off")
    this.ui.ended()
    if (post && wasActive) {
      await this.api(`${this.path}/conversation`, { method: "POST", json: { on: false }, keepalive }).catch(() => {})
    }
  }
}
