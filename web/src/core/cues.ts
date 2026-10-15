// Progress cue output for conversation mode: short Web Audio earcons and fixed phrases spoken through
// /api/speak (fetched once per phrase and kept in memory). Timing decisions live in feedback-core.ts.
import type { Cue } from "./feedback-core"

const EARCONS: Record<string, Array<{ freq?: number; ms?: number; gap?: number }>> = {
  heard: [{ freq: 880, ms: 80 }],
  done: [{ freq: 660, ms: 70 }, { gap: 50 }, { freq: 990, ms: 70 }],
}

type RateTarget = { defaultPlaybackRate?: number; playbackRate?: number; preservesPitch?: boolean; webkitPreservesPitch?: boolean }

/** Sets the playback rate (kept across source changes) with pitch preserved. */
export function applyRate(audio: RateTarget, rate: number): void {
  audio.defaultPlaybackRate = rate
  audio.playbackRate = rate
  audio.preservesPitch = true
  audio.webkitPreservesPitch = true
}

export type CueApi = (path: string, init: { method: string; json: { text: string } }) => Promise<Response>

interface Playable extends RateTarget {
  src: string
  paused: boolean
  play(): Promise<void>
  pause(): void
  onended: unknown
  onpause: unknown
  onerror: unknown
}

export class CuePlayer {
  private api: CueApi
  private speed?: () => number
  private onSpeaking?: (speaking: boolean) => void
  private phrases = new Map<string, Promise<string>>()
  private audio: Playable
  private ctx: AudioContext | undefined
  speaking = false

  constructor({ api, speed, onSpeaking, audio }: { api: CueApi; speed?: () => number; onSpeaking?: (speaking: boolean) => void; audio?: unknown }) {
    this.api = api
    this.speed = speed
    this.onSpeaking = onSpeaking
    this.audio = (audio ?? new Audio()) as Playable
  }

  /** Call from a user gesture: creates (or resumes) the earcon AudioContext. */
  unlock(): void {
    const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctx = g.AudioContext || g.webkitAudioContext
    if (!Ctx) return
    if (!this.ctx || this.ctx.state === "closed") this.ctx = new Ctx()
    this.ctx.resume?.().catch(() => {})
  }

  /** Plays cues from CueScheduler: earcons at once, phrases through the cue audio element. */
  play(cues: readonly Cue[] | undefined): void {
    for (const cue of cues ?? []) {
      if (cue.type === "earcon") this.earcon(cue.name)
      else if (cue.type === "speak") void this.say(cue.text)
    }
  }

  earcon(name: "heard" | "done"): void {
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
      const end = t + (part.ms ?? 0) / 1000
      osc.type = "sine"
      osc.frequency.value = part.freq ?? 440
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
  phrase(text: string): Promise<string> {
    let url = this.phrases.get(text)
    if (!url) {
      url = this.api("/api/speak", { method: "POST", json: { text } }).then(async (res) => URL.createObjectURL(await res.blob()))
      this.phrases.set(text, url)
      url.catch(() => this.phrases.delete(text))
    }
    return url
  }

  async say(text: string): Promise<void> {
    let url: string
    try {
      url = await this.phrase(text)
    } catch {
      return // cues are best-effort
    }
    const audio = this.audio
    this.setSpeaking(true)
    audio.src = url
    applyRate(audio, this.speed?.() ?? 1)
    const played = await audio.play().then(
      () => true,
      () => false,
    )
    if (!played) return this.setSpeaking(false)
    await new Promise<void>((resolve) => {
      audio.onended = audio.onpause = audio.onerror = () => resolve()
    })
    audio.onended = audio.onpause = audio.onerror = null
    this.setSpeaking(false)
  }

  /** Stops a phrase that is playing (user or agent started talking). */
  stop(): void {
    if (!this.audio.paused) this.audio.pause()
    this.setSpeaking(false)
  }

  private setSpeaking(on: boolean): void {
    if (on === this.speaking) return
    this.speaking = on
    this.onSpeaking?.(on)
  }

  close(): void {
    this.stop()
    this.ctx?.close?.().catch(() => {})
    this.ctx = undefined
  }
}
