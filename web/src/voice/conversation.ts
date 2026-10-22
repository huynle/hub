// Hands-free conversation mode for one session: always-on mic → speech detection (Silero VAD on-device, energy
// VAD as pre-gate and fallback) → speculative per-segment transcription → endpointing → POST utterance; SSE "say"
// text → sentence TTS queue with barge-in.
// Progress cues (earcons, short phrases like "On it." …) are scheduled by feedback-core and played by cues.
// The pure parts live in core/conversation-core; this file owns the browser APIs (mic, Web Audio, wake lock,
// media session). Ported from the 0.4 web/conversation.js; behavior unchanged except the mic device choice.
import { gestureBlocked } from "../core/voice-autostart"
import { Endpointer, micConstraints, SayAssembler, SpeechQueue, TurnTimer, describeTurn, encodeWav, parseCommand, type TurnMark, type VadEvent } from "../core/conversation-core"
import { sensitivityParams, VoiceDetector, type DetectorMode, type Sensitivity } from "../core/speech-vad"
import { junkTranscript } from "../core/junk-transcript"
import { loadSilero } from "./silero"
import { AudioClip, canStreamMp3, clipFrom, feed } from "../core/audio-stream"
import { CuePlayer } from "../core/cues"
import { cueLoudnessTarget, measureReply, normalizeCueAudio } from "./cue-loudness"
import { MicLiveness, recoveryDelay, type LossReason } from "../core/mic-liveness"
import { CueClock, CuePicker, cueTexts, CueScheduler, isWorking, subagentChanges, type StatusEntry } from "../core/feedback-core"
import type { ApiInit } from "../app/api"

const SENT_LABEL_MS = 2500
/** How long the Voice bar shows a dropped transcript ("ignored: Thank you."). */
const IGNORED_LABEL_MS = 3000

/** The model failing to load is logged once per page, not per Voice start. */
let warnedModel = false

const SILENCE_SECONDS = 2

/** Shown (as a button) when the browser starts Voice mode only after a tap, e.g. when opened from /voice. */
export const TAP_TO_START = "Tap to start Voice mode"
const GESTURE_ERROR = "GestureRequired"
const RESUME_WAIT_MS = 500
/** How often listening is checked (frames still arriving?). */
const MIC_CHECK_MS = 500
/** While hidden and not listening: how often to ask the audio graph to resume (best effort, screen off). */
const HIDDEN_RESUME_MS = 3000

const userActivated = () => (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true

async function micPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state
  } catch {
    return "unknown"
  }
}

/** `paused`: muted by the user; `suspended`: the phone stopped the microphone (screen off), not listening. */
export type ConversationState = "starting" | "listening" | "hearing" | "transcribing" | "sent" | "speaking" | "paused" | "suspended" | "off"
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
  /** The last turn's timing ("last turn: 1.8 s to first audio" and its steps), after its first audio played. */
  timing?(turn: { summary: string; detail: string }): void
  /** A transcript dropped as noise ("Thank you.", "you" …), shown briefly; "" clears it. */
  ignored?(text: string): void
  /** Which speech detector runs (the Silero model once loaded, else energy) and its mean inference round trip. */
  detector?(info: DetectorInfo): void
}

export interface DetectorInfo {
  readonly mode: DetectorMode
  /** Mean model round trip per 32 ms chunk (worker message + inference), in ms. */
  readonly avgMs?: number
}

/** performance.mark names of a turn's steps (visible in the browser's performance tools). */
const TURN_MARKS: Record<TurnMark, string> = {
  speechEnd: "hub-voice:speech-end",
  transcript: "hub-voice:transcript",
  accepted: "hub-voice:accepted",
  firstSay: "hub-voice:first-say",
  firstByte: "hub-voice:first-byte",
  firstAudio: "hub-voice:first-audio",
}

export interface ConversationOptions {
  cues?: boolean
  background?: boolean
  speed?: () => number
  title?: () => string
  status?: readonly StatusEntry[]
  /** Microphone deviceId ("" or undefined: the default). */
  deviceId?: string
  /** Mic sensitivity (Settings → Voice), read live: a change applies to the next audio. */
  sensitivity?: () => Sensitivity
}

type Api = (path: string, init?: ApiInit) => Promise<Response>

export { micConstraints }

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
  /** Typed utterances (no local end-of-speech tone): their hub `heard` plays the tone. */
  private typed = new Set<string>()
  private typing = 0
  private heardAt = 0
  private lastStatus: readonly StatusEntry[] | undefined
  /** Varied phrases, preferring ones whose audio is already loaded (cuePlayer is set in the constructor). */
  private cuePicker = new CuePicker({ ready: (text) => this.cuePlayer?.ready(text) ?? false })
  private scheduler = new CueScheduler({ pick: (cue) => this.cuePicker.pick(cue) })
  private cuePlayer: CuePlayer
  /** The TTS voice key (cue cache and reply loudness are kept per voice); fetched once per conversation. */
  private voiceKey?: Promise<string | undefined>
  private onVisibility: () => void
  /** Is the microphone really heard? The phone stops it with the screen off (muted track, suspended audio, no frames). */
  private liveness = new MicLiveness({ onChange: (live, reason) => this.livenessChanged(live, reason) })
  private micTimer: ReturnType<typeof setInterval> | undefined
  private recoverTimer: ReturnType<typeof setTimeout> | undefined
  private recoverAttempt = 0
  private recovering = false
  private lastResumeTry = 0
  private track?: MediaStreamTrack
  private stream?: MediaStream
  private ctx?: AudioContext
  private source?: MediaStreamAudioSourceNode
  private sink?: GainNode
  private tap?: AudioWorkletNode | ScriptProcessorNode
  private vad?: VoiceDetector
  private endpointer?: Endpointer
  private queue?: SpeechQueue<AudioClip>
  /** MediaSource plays a sentence while it downloads; without it (some iOS versions) each plays as a whole blob. */
  private readonly streaming = canStreamMp3(window as never)
  /** Orders and dedupes the sentence-by-sentence says; barge-in mutes the replies speaking. */
  private says = new SayAssembler()
  private turns = new TurnTimer()
  /** Plays progress phrases right on their deadline (re-armed by `poke()` after anything that may move it). */
  private cueClock: CueClock
  /** When the VAD last ended a segment: the acknowledgement counts from the end of the speech that was sent. */
  private speechEndedAt: number | undefined
  private silence?: HTMLAudioElement
  private silenceURL?: string
  private wakeLock?: WakeLockSentinel
  private warnedAutoplay = false
  private state: ConversationState | undefined
  private ignoredTimer: ReturnType<typeof setTimeout> | undefined
  /** The sensitivity the detector is tuned to. */
  private sensitivity: Sensitivity = "normal"
  /** A progress cue is playing (its echo must not barge in either). */
  private cueSpeaking = false
  /** Bumped by start() and stop(); a start that sees another value was cancelled. */
  private attempt = 0

  constructor({ sessionID, api, player, ui, options = {} }: { sessionID: string; api: Api; player: HTMLAudioElement; ui: ConversationUI<B>; options?: ConversationOptions }) {
    this.sessionID = sessionID
    this.api = api
    this.player = player
    this.ui = ui
    this.opts = { cues: true, background: false, speed: () => 1, title: () => "OpenCode session", sensitivity: () => "normal", ...options }
    this.lastStatus = options.status
    this.scheduler.enabled = this.opts.cues !== false
    this.scheduler.working(isWorking(options.status), Date.now())
    this.cuePlayer = new CuePlayer({
      api: this.api as never,
      speed: this.opts.speed,
      // Cues are normalised to the replies' loudness while they are prefetched (not when they play).
      normalize: normalizeCueAudio,
      target: cueLoudnessTarget,
      onSpeaking: (on) => {
        this.cueSpeaking = on
        this.guardEcho()
        this.scheduler.cueSpeaking(on, Date.now())
        this.cueClock.poke()
      },
    })
    this.cueClock = new CueClock({ scheduler: this.scheduler, play: (cues) => this.cuePlayer.play(cues), ready: () => this.active && !this.paused })
    this.onVisibility = () => {
      const visible = document.visibilityState === "visible"
      this.liveness.visibility(visible, Date.now())
      if (!this.active) return
      if (!visible) {
        // Best effort with the screen off: keep the silent loop going (Android may pause it with the page).
        if (this.opts.background && !this.paused) this.silence?.play().catch(() => {})
        return
      }
      if (!this.opts.background) void this.lockScreen()
      this.recover()
    }
  }

  /** Back on screen (bfcache, focus): bring the microphone back if the phone stopped it. */
  private onWake = (): void => {
    if (this.active && document.visibilityState === "visible") this.recover()
  }

  private onTrackMute = (): void => this.liveness.muted(true, Date.now())
  private onTrackUnmute = (): void => {
    this.liveness.muted(false, Date.now())
    this.recover()
  }
  private onTrackEnded = (): void => this.liveness.ended(Date.now())

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
      if (gestureBlocked({ error: err.name, micPermission: await micPermission(), activated: userActivated() })) {
        this.ui.note(TAP_TO_START, "gesture")
      } else {
        this.ui.note(err.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in the browser's site settings." : `Microphone: ${err.message}`, "err")
      }
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
    this.prefetchCues()
    try {
      await this.listen()
    } catch (e) {
      if (cancelled()) return false
      if ((e as Error).name === GESTURE_ERROR) this.ui.note(TAP_TO_START, "gesture")
      else this.ui.note(`Could not start listening: ${(e as Error).message}`, "err")
      await this.stop()
      return false
    }
    if (cancelled()) return false
    if (this.opts.background) this.mediaSession()
    else void this.lockScreen()
    this.liveness.visibility(document.visibilityState !== "hidden", Date.now())
    document.addEventListener("visibilitychange", this.onVisibility)
    window.addEventListener?.("pageshow", this.onWake)
    window.addEventListener?.("focus", this.onWake)
    this.micTimer = setInterval(() => this.checkMic(), MIC_CHECK_MS)
    this.cueClock.poke()
    this.refresh()
    return true
  }

  /** Loads the progress phrases now so each plays the moment its cue fires (cached per TTS voice). */
  private prefetchCues(): void {
    if (this.opts.cues === false || !this.scheduler.enabled) return
    // Fetched afresh: the voice may have changed since the last prefetch.
    void this.cuePlayer.prefetch(cueTexts(), (this.voiceKey = this.cueKey()))
  }

  /** The TTS settings that shape cue audio (provider, model, voice, speed, server); undefined if unknown. */
  private async cueKey(): Promise<string | undefined> {
    try {
      const { tts } = (await (await this.api("/api/settings/speech")).json()) as { tts?: Record<string, unknown> }
      if (!tts?.voice) return undefined
      return [tts.provider, tts.model, tts.voice, tts.speed ?? "", tts.baseURL ?? ""].join("|")
    } catch {
      return undefined
    }
  }

  private async listen(): Promise<void> {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const AudioCtx = (w.AudioContext || w.webkitAudioContext)!
    const ctx = (this.ctx = new AudioCtx())
    // Without a tap the browser keeps the context suspended (autoplay policy): nothing would be heard.
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, RESUME_WAIT_MS))])
    if (gestureBlocked({ audioState: ctx.state, activated: userActivated() })) throw Object.assign(new Error(TAP_TO_START), { name: GESTURE_ERROR })
    this.liveness.start(Date.now())
    ctx.onstatechange = () => this.liveness.audio(ctx.state, Date.now())
    this.watchTrack(this.stream!)
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

    this.sensitivity = this.opts.sensitivity()
    const detector = (this.vad = new VoiceDetector({
      sampleRate: ctx.sampleRate,
      params: sensitivityParams(this.sensitivity),
      onEvents: (events) => this.vadEvents(events),
      onLevel: (level) => this.ui.level(level),
    }))
    this.ui.detector?.({ mode: "energy" })
    // The model loads in the background (energy detection meanwhile); it stays loaded for later starts.
    loadSilero().then(
      (silero) => {
        if (this.vad !== detector) return
        silero.reset()
        detector.classifier = (chunk) => silero.classify(chunk)
        this.ui.detector?.({ mode: "silero" })
      },
      (error) => {
        if (!warnedModel) console.warn(`Voice: on-device speech detection unavailable (${error?.message ?? error}); using the energy detector`)
        warnedModel = true
      },
    )
    this.endpointer = new Endpointer({
      send: (text) => void this.deliver(text),
      onHeld: (text) => this.ui.held?.(text),
    })
    this.queue = new SpeechQueue<AudioClip>({
      synth: (text, signal) => this.synth(text, signal),
      play: (clip) => this.play(clip),
      stop: () => {
        if (!this.player.paused) this.player.pause()
      },
      onState: (speaking) => {
        this.guardEcho()
        this.scheduler.agentSpeaking(speaking, Date.now())
        if (speaking) this.cuePlayer.stop() // the agent's own speech wins over a cue
        this.cueClock.poke()
        this.refresh()
      },
      onError: (error) => {
        if (error?.name !== "AbortError") this.ui.note(`Could not read the reply aloud: ${error?.message}`, "err")
      },
    })
  }

  /** The detector's echo guard is up while a reply or a cue plays (and briefly after). */
  private guardEcho(): void {
    if (this.vad) this.vad.speaking = !!this.queue?.speaking || this.cueSpeaking
  }

  /** One ~20 ms frame from the mic. */
  private frame(samples: Float32Array): void {
    if (!this.active) return
    this.liveness.frame(Date.now())
    if (!this.vad || this.paused || !this.liveness.live) return
    const sensitivity = this.opts.sensitivity()
    if (sensitivity !== this.sensitivity) {
      this.sensitivity = sensitivity
      this.vad.params = sensitivityParams(sensitivity)
    }
    this.vad.push(samples)
  }

  /** Speech starts and ends from the detector (in stream order; possibly after the frame, when the model answers). */
  private vadEvents(events: readonly VadEvent[]): void {
    const vad = this.vad
    if (!this.active || !vad || this.paused || !this.liveness.live) return
    for (const event of events) {
      if (event.type === "start") {
        this.endpointer!.speechStarted()
        this.scheduler.userTalking(true, Date.now())
        this.cuePlayer.stop()
        // Barge-in (start fires only after the detector's minSpeechMs of voice): the reply speaking, or one still being
        // written between two sentences, goes quiet; the utterance then steers the agent. Workers are not touched.
        if (this.queue!.speaking) this.hushReplies()
        else this.says.mute()
      } else {
        // Instant acknowledgement: the segment goes to transcription, so the user hears it was taken.
        this.speechEndedAt = Date.now()
        this.markTurn("speechEnd")
        this.cuePlayer.play(this.scheduler.speechEnded(this.speechEndedAt))
        const id = this.endpointer!.segmentEnded(event.durationMs)
        void this.transcribe(id, encodeWav(event.samples, vad.sampleRate), event.speechMs)
        this.ui.detector?.({ mode: vad.mode, ...(vad.mode === "silero" ? { avgMs: vad.stats.avgMs } : {}) })
      }
      this.cueClock.poke()
      this.refresh()
    }
  }

  private async transcribe(id: number, wav: Uint8Array<ArrayBuffer>, speechMs: number): Promise<void> {
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
    // Speech-to-text's take on noise ("Thank you.", "you", "[Music]" …) never reaches the agent.
    if (junkTranscript(text, { speechMs })) {
      if (text.trim()) this.showIgnored(text.trim())
      text = ""
    }
    if (text.trim()) this.markTurn("transcript")
    this.endpointer?.transcribed(id, text)
    this.refresh()
  }

  private showIgnored(text: string): void {
    clearTimeout(this.ignoredTimer)
    this.ui.ignored?.(text)
    this.ignoredTimer = setTimeout(() => this.ui.ignored?.(""), IGNORED_LABEL_MS)
  }

  /** A finished utterance from the endpointer (or typed text): a voice command or a steer. */
  private async deliver(text: string, typed = false): Promise<void> {
    const command = parseCommand(text)
    if (command === "pause") {
      this.ui.note("Paused listening.")
      return this.stop()
    }
    if (command === "interrupt") {
      this.hushReplies()
      this.ui.note(`“${text}” — interrupting.`)
      try {
        await this.api(`${this.path}/interrupt`, { method: "POST", json: {} })
      } catch (e) {
        this.ui.note(`Could not interrupt: ${(e as Error).message}`, "err")
      }
      return
    }
    const bubble = this.ui.user(text)
    if (typed) this.typing++
    this.scheduler.awaitReply(typed ? Date.now() : (this.speechEndedAt ?? Date.now()))
    this.cueClock.poke()
    try {
      const { inboxID } = await (await this.api(`${this.path}/utterance`, { method: "POST", json: { text } })).json()
      this.markTurn("accepted")
      if (this.sent.get(inboxID) === "heard") this.ui.tick(bubble, "heard") // delivery beat the response
      else {
        this.ui.tick(bubble, "sent")
        if (typed) this.typed.add(inboxID)
      }
      this.sent.set(inboxID, bubble)
    } catch (e) {
      const err = e as Error & { status?: number }
      this.ui.tick(bubble, "failed")
      this.ui.note(err.status === 409 ? err.message : `Could not send: ${err.message}`, "err")
    } finally {
      if (typed) this.typing--
    }
  }

  /** Typed text while Voice mode is on goes the same way as speech. */
  sendTyped(text: string): Promise<void> {
    this.hushReplies()
    return this.deliver(text, true)
  }

  /** Stops reading replies aloud, including their sentences still to come. */
  private hushReplies(): void {
    this.queue?.clear()
    this.says.mute()
  }

  /** Hub SSE messages for this session. */
  onEvent(message: Record<string, any>): void {
    if (message.sessionID !== this.sessionID) return
    if (message.type === "heard") {
      const bubble = this.sent.get(message.inboxID)
      if (bubble !== undefined && bubble !== "heard") this.ui.tick(bubble, "heard")
      else this.sent.set(message.inboxID, "heard")
      this.heardAt = Date.now()
      // Spoken utterances were acknowledged at the end of speech; typed ones (also when the hub's heard beats
      // the POST response) get the tone now.
      const tone = this.typed.delete(message.inboxID) || (bubble === undefined && this.typing > 0)
      if (this.active && !this.paused) this.cuePlayer.play(this.scheduler.heard(this.heardAt, { tone }))
      this.cueClock.poke()
      this.refresh()
      setTimeout(() => this.refresh(), SENT_LABEL_MS + 50)
    } else if (message.type === "say") {
      if (!this.active) return
      // Root replies arrive one sentence at a time while they are written (seq); played in order, once.
      const accepted = this.says.accept(message as { messageID?: string; ordinal?: number; seq?: number; text: string })
      if (!accepted) return
      this.scheduler.agentSaid(Date.now())
      this.cuePlayer.stop()
      this.cueClock.poke()
      this.ui.agent({ messageID: message.messageID, text: accepted.text })
      if (accepted.sentences.length) this.markTurn("firstSay")
      this.queue?.enqueue(accepted.sentences)
    } else if (message.type === "conversation" && !message.on && this.active) {
      this.ui.note("Voice mode was turned off.")
      void this.stop({ post: false })
    }
  }

  /** Status tree of this root session: drives the hand-off phrase, the subagent-done earcon and the still-working phrase. */
  onStatus(sessions: readonly StatusEntry[]): void {
    const now = Date.now()
    const { started, finished } = subagentChanges(this.lastStatus, sessions, this.sessionID)
    this.lastStatus = sessions
    this.scheduler.working(isWorking(sessions), now)
    if (!this.active) return
    for (let i = 0; i < started.length; i++) this.scheduler.subagentStarted(now)
    if (finished.length && !this.paused) this.cuePlayer.play(this.scheduler.subagentFinished(now))
    this.cueClock.poke()
  }

  setCues(on: boolean): void {
    this.scheduler.enabled = on
    if (!on) this.cuePlayer.stop()
    else if (this.active) this.prefetchCues()
    this.cueClock.poke()
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
    this.cueClock.stop()
    this.hushReplies()
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
    this.cueClock.poke()
    this.refresh()
  }

  /**
   * Lock screen / notification controls (Android Chrome shows them while media plays). The metadata ("Voice
   * mode on", the session title) and the pause/stop → End handlers are app-level (web/src/app/voice.ts); the
   * conversation only reports whether it plays.
   */
  private mediaSession(): void {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = this.paused || !this.liveness.live ? "paused" : "playing"
  }

  /** Follows the microphone track's mute / unmute / ended (the phone stopping it with the screen off). */
  private watchTrack(stream: MediaStream): void {
    this.unwatchTrack()
    const track = stream.getAudioTracks?.()[0]
    if (!track?.addEventListener) return
    this.track = track
    track.addEventListener("mute", this.onTrackMute)
    track.addEventListener("unmute", this.onTrackUnmute)
    track.addEventListener("ended", this.onTrackEnded)
    if (track.muted) this.liveness.muted(true, Date.now())
    if (track.readyState === "ended") this.liveness.ended(Date.now())
  }

  private unwatchTrack(): void {
    const track = this.track
    this.track = undefined
    if (!track?.removeEventListener) return
    track.removeEventListener("mute", this.onTrackMute)
    track.removeEventListener("unmute", this.onTrackUnmute)
    track.removeEventListener("ended", this.onTrackEnded)
  }

  /** Periodic: frames still arriving? While hidden and not listening, nudge the audio graph now and then. */
  private checkMic(): void {
    if (!this.active) return
    const now = Date.now()
    this.liveness.tick(now)
    if (this.liveness.live || document.visibilityState === "visible" || now - this.lastResumeTry < HIDDEN_RESUME_MS) return
    this.lastResumeTry = now
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {})
    if (this.opts.background && !this.paused) this.silence?.play().catch(() => {})
  }

  /** Listening stopped (tell the user plainly, a falling tone) or came back (a rising tone). */
  private livenessChanged(live: boolean, _reason?: LossReason): void {
    if (!this.active) return
    if (live) {
      clearTimeout(this.recoverTimer)
      this.recoverTimer = undefined
      this.recoverAttempt = 0
      this.cuePlayer.earcon("resumed")
      this.cueClock.poke()
    } else {
      // Half-heard speech is dropped; utterances already being transcribed still go out.
      this.vad?.reset()
      this.ui.level(0)
      this.cuePlayer.earcon("paused")
      this.lastResumeTry = Date.now() // hidden: the first nudge comes after HIDDEN_RESUME_MS
      if (this.liveness.wantsRecovery) this.scheduleRecover()
    }
    if (this.opts.background) this.mediaSession()
    this.refresh()
  }

  /** Tries again later while the page is visible and listening has not come back (backoff up to 8 s). */
  private scheduleRecover(): void {
    if (this.recoverTimer !== undefined || !this.active) return
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = undefined
      this.recover()
    }, recoveryDelay(this.recoverAttempt++))
  }

  /** Brings listening back: resumes the audio graph, asks for the microphone again if its track ended. */
  private recover(): void {
    if (!this.active || this.liveness.live || this.recovering) return
    clearTimeout(this.recoverTimer)
    this.recoverTimer = undefined
    this.recovering = true
    void this.tryRecover().finally(() => {
      this.recovering = false
      if (this.active && this.liveness.wantsRecovery) this.scheduleRecover()
    })
  }

  private async tryRecover(): Promise<void> {
    this.cuePlayer.unlock()
    const ctx = this.ctx
    const resumed = ctx && ctx.state !== "running" ? ctx.resume().catch(() => {}) : undefined
    if (this.opts.background && !this.paused) this.silence?.play().catch(() => {})
    if (this.liveness.needsMic || this.track?.readyState === "ended") await this.reacquire()
    else if (resumed) await Promise.race([resumed, new Promise((r) => setTimeout(r, RESUME_WAIT_MS))])
    // Listening is back only once frames arrive (MicLiveness).
  }

  /** The track ended: a new one from getUserMedia, wired into the same audio graph. */
  private async reacquire(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(this.opts.deviceId))
    } catch (e) {
      if (!this.active) return
      const err = e as Error
      // Only a tap brings the microphone back: Voice mode ends and the view offers "Tap to start Voice mode".
      if (gestureBlocked({ error: err.name, micPermission: await micPermission(), activated: userActivated() })) this.ui.note(TAP_TO_START, "gesture")
      return
    }
    if (!this.active || !this.ctx || !this.tap) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.release()
    this.stream = stream
    if (this.paused) stream.getAudioTracks().forEach((t) => (t.enabled = false))
    try {
      this.source?.disconnect()
    } catch {
      // already disconnected
    }
    this.source = this.ctx.createMediaStreamSource(stream)
    this.source.connect(this.tap)
    this.liveness.replaced(Date.now())
    this.watchTrack(stream)
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
    this.hushReplies()
    this.cuePlayer.stop()
  }

  /**
   * Starts downloading a sentence's audio: resolves once the hub answers (the bytes keep arriving into the
   * clip, also while it waits behind the sentence playing). The barge-in's `signal` cancels the download.
   */
  private async synth(text: string, signal: AbortSignal): Promise<AudioClip> {
    const res = await this.api("/api/speak", { method: "POST", json: { text }, signal })
    const clip = clipFrom(res.body, signal)
    clip.firstByte.then(
      () => this.markTurn("firstByte"),
      () => {},
    )
    // Once complete, the sentence's loudness is measured off the playback path: cues follow the replies.
    void clip
      .whole()
      .then(async (chunks) => measureReply(chunks, await (this.voiceKey ??= this.cueKey())))
      .catch(() => {})
    return clip
  }

  /** Plays a clip: through MediaSource as it downloads, else (no MSE for MP3) once complete as a blob. */
  private async play(clip: AudioClip): Promise<void> {
    const player = this.player
    const stop = new AbortController()
    let url: string | undefined
    try {
      if (this.streaming) {
        await clip.firstByte
        if (clip.done && !clip.chunks.length) return
        const source = new MediaSource()
        url = URL.createObjectURL(source)
        player.src = url
        void this.feedSource(source, clip, stop.signal)
      } else {
        const chunks = await clip.whole()
        if (!chunks.length) return
        url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: "audio/mpeg" }))
        player.src = url
      }
      // Listen before play() so a very short sentence cannot end unnoticed.
      const finished = new Promise<void>((resolve) => {
        player.onended = player.onpause = player.onerror = () => resolve()
      })
      const played = await player.play().then(
        () => true,
        () => false,
      )
      if (!played) {
        if (!this.warnedAutoplay) this.ui.note("The browser blocked audio playback. Tap the mic to allow it.")
        this.warnedAutoplay = true
        return
      }
      this.markTurn("firstAudio")
      await finished
    } finally {
      stop.abort()
      player.onended = player.onpause = player.onerror = null
      if (url) URL.revokeObjectURL(url)
    }
  }

  /** Appends a clip to a MediaSource as its bytes arrive; a broken download ends the stream with what came. */
  private async feedSource(source: MediaSource, clip: AudioClip, signal: AbortSignal): Promise<void> {
    try {
      if (source.readyState !== "open") await new Promise((resolve) => source.addEventListener("sourceopen", resolve, { once: true }))
      if (signal.aborted) return
      const buffer = source.addSourceBuffer("audio/mpeg")
      const ended = await feed(
        clip,
        {
          append: (chunk) =>
            new Promise<void>((resolve, reject) => {
              buffer.addEventListener("updateend", () => resolve(), { once: true })
              buffer.addEventListener("error", () => reject(new Error("Could not decode the reply audio")), { once: true })
              buffer.appendBuffer(chunk as BufferSource)
            }),
          end: () => {
            if (source.readyState === "open" && !buffer.updating) source.endOfStream()
          },
        },
        signal,
      )
      if (!ended && !signal.aborted && source.readyState === "open" && !buffer.updating) source.endOfStream()
    } catch {
      // The element reports the failure (error event) or was stopped.
    }
  }

  /** Records a turn step (also as a performance mark); the first audio reports the turn's timing. */
  private markTurn(name: TurnMark): void {
    if (!this.turns.mark(name, Date.now())) return
    try {
      performance.mark(TURN_MARKS[name])
    } catch {
      // no User Timing here
    }
    const turn = name === "firstAudio" ? describeTurn(this.turns.last) : undefined
    if (turn) this.ui.timing?.(turn)
  }

  private refresh(): void {
    if (!this.active) return
    const state: ConversationState = this.paused
      ? "paused"
      : !this.liveness.live
        ? "suspended"
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
    this.unwatchTrack()
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
    window.removeEventListener?.("pageshow", this.onWake)
    window.removeEventListener?.("focus", this.onWake)
    clearInterval(this.micTimer)
    clearTimeout(this.recoverTimer)
    this.micTimer = this.recoverTimer = undefined
    this.recoverAttempt = 0
    if (this.ctx) this.ctx.onstatechange = null
    this.cueClock.stop()
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
    clearTimeout(this.ignoredTimer)
    this.ui.ignored?.("")
    this.ui.state("off")
    this.ui.ended()
    if (post && wasActive) {
      await this.api(`${this.path}/conversation`, { method: "POST", json: { on: false }, keepalive }).catch(() => {})
    }
  }
}
