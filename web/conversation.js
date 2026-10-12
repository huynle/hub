// Hands-free conversation mode for one session: always-on mic → energy VAD → speculative per-segment
// transcription → endpointing → POST utterance; SSE "say" text → sentence TTS queue with barge-in.
// Progress cues (earcons, "Working on it." …) are scheduled by feedback-core.js and played by cues.js.
// The pure parts live in conversation-core.js; this file owns the browser APIs (mic, Web Audio, wake lock,
// media session).
import { Endpointer, EnergyVad, SpeechQueue, encodeWav, parseCommand, splitSentences } from "./conversation-core.js"
import { CueScheduler, isWorking, subagentChanges } from "./feedback-core.js"
import { CuePlayer } from "./cues.js"

const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
const SENT_LABEL_MS = 2500
const CUE_TICK_MS = 1000
const SILENCE_SECONDS = 2

/**
 * @param {object} options
 * @param {string} options.sessionID
 * @param {(path: string, init?: object) => Promise<Response>} options.api  same-origin fetch that throws on !ok
 * @param {HTMLAudioElement} options.player
 * @param {object} options.ui  view callbacks: state, level, user, tick, agent, note, held, ended
 * @param {object} [options.options]
 * @param {boolean} [options.options.cues]  spoken progress cues (default on)
 * @param {boolean} [options.options.background]  keep listening with the screen off (no wake lock, media session)
 * @param {() => number} [options.options.speed]  playback rate for cue phrases
 * @param {() => string} [options.options.title]  session title for the lock screen
 * @param {object[]} [options.options.status]  current status tree (subagents already running don't cue)
 */
export class Conversation {
  constructor({ sessionID, api, player, ui, options = {} }) {
    Object.assign(this, { sessionID, api, player, ui })
    this.opts = { cues: true, background: false, speed: () => 1, title: () => "OpenCode session", ...options }
    this.active = false
    this.paused = false
    this.inflight = 0 // transcriptions running
    this.sent = new Map() // inboxID → user bubble
    this.heardAt = 0
    this.lastStatus = options.status
    this.scheduler = new CueScheduler()
    this.scheduler.enabled = this.opts.cues !== false
    this.scheduler.working(isWorking(options.status), Date.now())
    this.cuePlayer = new CuePlayer({ api, speed: this.opts.speed, onSpeaking: (on) => this.scheduler.cueSpeaking(on, Date.now()) })
    this.onVisibility = () => {
      if (document.visibilityState === "visible" && this.active && !this.opts.background) this.lockScreen()
    }
  }

  get path() {
    return `/api/sessions/${encodeURIComponent(this.sessionID)}`
  }

  /** Mic first (a refusal leaves the server untouched), then the server flag. Returns false on failure. */
  async start() {
    if (this.active) return true
    this.ui.state("starting")
    this.cuePlayer.unlock() // still inside the tap
    if (this.opts.background) this.startSilence()
    if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
      this.ui.note("This browser cannot listen here (the microphone needs HTTPS).", "err")
      this.ui.state("off")
      return false
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
    } catch (e) {
      this.ui.note(e.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in the browser's site settings." : `Microphone: ${e.message}`, "err")
      this.ui.state("off")
      this.stopSilence()
      return false
    }
    try {
      const { agent } = await (await this.api(`${this.path}/conversation`, { method: "POST", json: { on: true } })).json()
      this.agent = agent
    } catch (e) {
      this.release()
      this.stopSilence()
      this.ui.note(`Could not start conversation mode: ${e.message}`, "err")
      this.ui.state("off")
      return false
    }
    this.active = true
    try {
      await this.listen()
    } catch (e) {
      this.ui.note(`Could not start listening: ${e.message}`, "err")
      await this.stop()
      return false
    }
    if (this.opts.background) this.mediaSession()
    else this.lockScreen()
    document.addEventListener("visibilitychange", this.onVisibility)
    this.ticker = setInterval(() => this.tickCues(), CUE_TICK_MS)
    this.refresh()
    return true
  }

  async listen() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    const ctx = (this.ctx = new AudioCtx())
    await ctx.resume().catch(() => {})
    this.source = ctx.createMediaStreamSource(this.stream)
    this.sink = ctx.createGain()
    this.sink.gain.value = 0 // keeps the tap pulled by the graph without making a sound
    this.sink.connect(ctx.destination)
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      await ctx.audioWorklet.addModule("/vad-worklet.js")
      this.tap = new AudioWorkletNode(ctx, "vad-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
      this.tap.port.onmessage = (event) => this.frame(event.data)
    } else {
      this.tap = ctx.createScriptProcessor(1024, 1, 1)
      this.tap.onaudioprocess = (event) => this.frame(Float32Array.from(event.inputBuffer.getChannelData(0)))
    }
    this.source.connect(this.tap)
    this.tap.connect(this.sink)

    this.vad = new EnergyVad({ sampleRate: ctx.sampleRate })
    this.endpointer = new Endpointer({
      send: (text) => this.deliver(text),
      onHeld: (text) => this.ui.held?.(text),
    })
    this.queue = new SpeechQueue({
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
        if (error?.name !== "AbortError") this.ui.note(`Could not read the reply aloud: ${error.message}`, "err")
      },
    })
  }

  /** One ~20 ms frame from the mic. */
  frame(samples) {
    if (!this.active || !this.vad || this.paused) return
    const { level, events } = this.vad.process(samples)
    this.ui.level(level)
    for (const event of events) {
      if (event.type === "start") {
        this.endpointer.speechStarted()
        this.scheduler.userTalking(true, Date.now())
        this.cuePlayer.stop()
        if (this.queue.speaking) this.queue.clear() // barge-in: start fires only after 250 ms of voice
      } else {
        this.scheduler.userTalking(false, Date.now())
        const id = this.endpointer.segmentEnded(event.durationMs)
        this.transcribe(id, encodeWav(event.samples, this.vad.sampleRate))
      }
      this.refresh()
    }
  }

  async transcribe(id, wav) {
    this.inflight++
    this.refresh()
    let text = ""
    try {
      text = (await (await this.api("/api/transcribe", { method: "POST", body: wav, headers: { "content-type": "audio/wav" } })).json()).text ?? ""
    } catch (e) {
      if (this.active) this.ui.note(`Transcription failed: ${e.message}`, "err")
    } finally {
      this.inflight--
    }
    if (!this.active) return
    this.endpointer.transcribed(id, text)
    this.refresh()
  }

  /** A finished utterance from the endpointer (or typed text): a voice command or a steer. */
  async deliver(text) {
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
        this.ui.note(`Could not interrupt: ${e.message}`, "err")
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
      this.ui.tick(bubble, "failed")
      this.ui.note(e.status === 409 ? e.message : `Could not send: ${e.message}`, "err")
    }
  }

  /** Typed text while conversation mode is on goes the same way as speech. */
  sendTyped(text) {
    this.queue?.clear()
    return this.deliver(text)
  }

  /** Hub SSE messages for this session. */
  onEvent(message) {
    if (message.sessionID !== this.sessionID) return
    if (message.type === "heard") {
      const bubble = this.sent.get(message.inboxID)
      if (bubble && bubble !== "heard") this.ui.tick(bubble, "heard")
      else this.sent.set(message.inboxID, "heard")
      this.heardAt = Date.now()
      if (this.active && !this.paused) this.cuePlayer.play(this.scheduler.heard(this.heardAt))
      this.refresh()
      setTimeout(() => this.refresh(), SENT_LABEL_MS + 50)
    } else if (message.type === "say") {
      if (!this.active) return
      this.scheduler.agentSaid(Date.now())
      this.cuePlayer.stop()
      this.ui.agent(message)
      this.queue.enqueue(splitSentences(message.text))
    } else if (message.type === "conversation" && !message.on && this.active) {
      this.ui.note("Conversation mode was turned off.")
      this.stop({ post: false })
    }
  }

  /** Status tree of this root session: drives "Started a subagent.", the subagent-done earcon and "Still working.". */
  onStatus(sessions) {
    const now = Date.now()
    const { started, finished } = subagentChanges(this.lastStatus, sessions, this.sessionID)
    this.lastStatus = sessions
    this.scheduler.working(isWorking(sessions), now)
    if (!this.active) return
    for (let i = 0; i < started.length; i++) this.scheduler.subagentStarted(now)
    if (finished.length && !this.paused) this.cuePlayer.play(this.scheduler.subagentFinished(now))
    this.tickCues()
  }

  tickCues() {
    if (!this.active || this.paused) return
    this.cuePlayer.play(this.scheduler.tick(Date.now()))
  }

  setCues(on) {
    this.scheduler.enabled = on
    if (!on) this.cuePlayer.stop()
  }

  /** Switches screen-off listening while active: wake lock ↔ media session + silent loop. */
  setBackground(on) {
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
      this.lockScreen()
    }
  }

  /** Lock-screen pause: stop listening (mic muted, speech cleared) but keep the mode on for a quick resume. */
  pause() {
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

  resume() {
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

  /** Lock screen / notification controls (Android Chrome shows them while media plays). */
  mediaSession() {
    const ms = navigator.mediaSession
    if (!ms) return
    try {
      if (window.MediaMetadata) {
        ms.metadata = new MediaMetadata({
          title: this.opts.title(),
          artist: "OpenCode Voice",
          artwork: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          ],
        })
      }
      ms.setActionHandler("pause", () => this.pause())
      ms.setActionHandler("play", () => this.resume())
      ms.playbackState = this.paused ? "paused" : "playing"
    } catch {
      // unsupported action or metadata: controls are best-effort
    }
  }

  clearMediaSession() {
    const ms = navigator.mediaSession
    if (!ms) return
    try {
      ms.metadata = null
      ms.setActionHandler("pause", null)
      ms.setActionHandler("play", null)
      ms.playbackState = "none"
    } catch {
      // ignore
    }
  }

  /**
   * A silent looping <audio> while listening with the screen off: an audible-media page is less likely to be
   * suspended, and it gives the media session its lock-screen controls. Best-effort; browsers may still suspend.
   */
  startSilence() {
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

  stopSilence() {
    if (!this.silence) return
    this.silence.pause()
    this.silence.removeAttribute("src")
    this.silence.load()
    URL.revokeObjectURL(this.silenceURL)
    this.silence = this.silenceURL = undefined
  }

  /** Stops reading aloud (mic tap while speaking); resumes listening when paused. */
  hush() {
    if (this.paused) return this.resume()
    this.queue?.clear()
    this.cuePlayer.stop()
  }

  async synth(text, signal) {
    const res = await this.api("/api/speak", { method: "POST", json: { text }, signal })
    return URL.createObjectURL(await res.blob())
  }

  async play(url) {
    const player = this.player
    try {
      player.src = url
      const played = await player.play().then(() => true, () => false)
      if (!played) {
        if (!this.warnedAutoplay) this.ui.note("The browser blocked audio playback. Tap the mic to allow it.")
        this.warnedAutoplay = true
        return
      }
      await new Promise((resolve) => {
        player.onended = player.onpause = player.onerror = () => resolve()
      })
    } finally {
      player.onended = player.onpause = player.onerror = null
      URL.revokeObjectURL(url)
    }
  }

  refresh() {
    if (!this.active) return
    const state = this.paused
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

  async lockScreen() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return
    if (this.wakeLock && !this.wakeLock.released) return
    try {
      this.wakeLock = await navigator.wakeLock.request("screen")
    } catch {
      // Battery saver or no permission: the screen may sleep, listening continues while visible.
    }
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = undefined
  }

  /** Turns everything off; `post: false` when the server already did (SSE) or the page is going away. */
  async stop({ post = true, keepalive = false } = {}) {
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
      if (this.tap?.port) this.tap.port.onmessage = null
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
