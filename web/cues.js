// Progress cue output for conversation mode: short Web Audio earcons and fixed phrases spoken through
// /api/speak (fetched once per phrase and kept in memory). Timing decisions live in feedback-core.js.

const EARCONS = {
  heard: [{ freq: 880, ms: 80 }],
  done: [{ freq: 660, ms: 70 }, { gap: 50 }, { freq: 990, ms: 70 }],
}

/** Sets the playback rate (kept across source changes) with pitch preserved. */
export function applyRate(audio, rate) {
  audio.defaultPlaybackRate = rate
  audio.playbackRate = rate
  audio.preservesPitch = true
  audio.webkitPreservesPitch = true
}

export class CuePlayer {
  /**
   * @param {object} options
   * @param {(path: string, init?: object) => Promise<Response>} options.api
   * @param {() => number} [options.speed]  playback rate for spoken phrases
   * @param {(speaking: boolean) => void} [options.onSpeaking]
   * @param {HTMLAudioElement} [options.audio]
   */
  constructor({ api, speed, onSpeaking, audio }) {
    Object.assign(this, { api, speed, onSpeaking })
    this.phrases = new Map() // text → Promise<object URL>
    this.audio = audio ?? new Audio()
    this.speaking = false
  }

  /** Call from a user gesture: creates (or resumes) the earcon AudioContext. */
  unlock() {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext
    if (!Ctx) return
    if (!this.ctx || this.ctx.state === "closed") this.ctx = new Ctx()
    this.ctx.resume?.().catch(() => {})
  }

  /** Plays cues from CueScheduler: earcons at once, phrases through the cue audio element. */
  play(cues) {
    for (const cue of cues ?? []) {
      if (cue.type === "earcon") this.earcon(cue.name)
      else if (cue.type === "speak") this.say(cue.text)
    }
  }

  earcon(name) {
    const ctx = this.ctx
    const parts = EARCONS[name]
    if (!ctx || !parts || ctx.state === "closed") return
    let t = ctx.currentTime + 0.01
    for (const part of parts) {
      if (part.gap) {
        t += part.gap / 1000
        continue
      }
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const end = t + part.ms / 1000
      osc.type = "sine"
      osc.frequency.value = part.freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(end + 0.02)
      t = end
    }
  }

  /** Cached object URL for a fixed phrase (one /api/speak call per phrase per page load). */
  phrase(text) {
    let url = this.phrases.get(text)
    if (!url) {
      url = this.api("/api/speak", { method: "POST", json: { text } }).then(async (res) => URL.createObjectURL(await res.blob()))
      this.phrases.set(text, url)
      url.catch(() => this.phrases.delete(text))
    }
    return url
  }

  async say(text) {
    let url
    try {
      url = await this.phrase(text)
    } catch {
      return // cues are best-effort
    }
    const audio = this.audio
    this.setSpeaking(true)
    audio.src = url
    applyRate(audio, this.speed?.() ?? 1)
    const played = await audio.play().then(() => true, () => false)
    if (!played) return this.setSpeaking(false)
    await new Promise((resolve) => {
      audio.onended = audio.onpause = audio.onerror = () => resolve()
    })
    audio.onended = audio.onpause = audio.onerror = null
    this.setSpeaking(false)
  }

  /** Stops a phrase that is playing (user or agent started talking). */
  stop() {
    if (!this.audio.paused) this.audio.pause()
    this.setSpeaking(false)
  }

  setSpeaking(on) {
    if (on === this.speaking) return
    this.speaking = on
    this.onSpeaking?.(on)
  }

  close() {
    this.stop()
    this.ctx?.close?.().catch(() => {})
    this.ctx = undefined
  }
}
