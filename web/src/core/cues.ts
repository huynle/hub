// Progress cue output for conversation mode: short Web Audio earcons and short varied phrases spoken through
// /api/speak. Phrases are prefetched when Voice mode starts and kept in memory and, keyed by the TTS voice
// and the text, in Cache Storage, so later sessions start with them ready. A phrase that is not ready when
// its cue fires plays a short tone instead (it never waits for synthesis). Timing decisions live in
// feedback-core.ts.
import type { Cue } from "./feedback-core"

const EARCONS = {
  heard: [{ freq: 880, ms: 80 }],
  done: [{ freq: 660, ms: 70 }, { gap: 50 }, { freq: 990, ms: 70 }],
  /** Stands in for a phrase that is not synthesized yet. */
  pending: [{ freq: 587, ms: 110 }],
  /** Listening stopped (the phone took the microphone away): descending. */
  paused: [{ freq: 784, ms: 90 }, { gap: 40 }, { freq: 523, ms: 160 }],
  /** Listening again: ascending. */
  resumed: [{ freq: 523, ms: 90 }, { gap: 40 }, { freq: 784, ms: 120 }],
} satisfies Record<string, Array<{ freq?: number; ms?: number; gap?: number }>>
export type EarconName = keyof typeof EARCONS

/** Cache Storage name and the (never fetched) URLs that key cue audio: one folder per voice key. */
export const CUE_CACHE = "hub-cues-v1"
const CUE_URL = "https://hub-cues.invalid"
const cueFolder = (key: string) => `${CUE_URL}/${encodeURIComponent(key)}/`
const cueURL = (key: string, text: string) => `${cueFolder(key)}${encodeURIComponent(text)}`

type CueStore = Pick<Cache, "match" | "put" | "keys" | "delete">

async function cueStore(): Promise<CueStore | undefined> {
  try {
    const storage = (globalThis as { caches?: CacheStorage }).caches
    return storage ? await storage.open(CUE_CACHE) : undefined
  } catch {
    return undefined // no Cache Storage here (insecure context, private mode): memory only
  }
}

type RateTarget = { defaultPlaybackRate?: number; playbackRate?: number; preservesPitch?: boolean; webkitPreservesPitch?: boolean }

/** Sets the playback rate (kept across source changes) with pitch preserved. */
export function applyRate(audio: RateTarget, rate: number): void {
  audio.defaultPlaybackRate = rate
  audio.playbackRate = rate
  audio.preservesPitch = true
  audio.webkitPreservesPitch = true
}

/** Phrases synthesized at once while prefetching (keeps the TTS provider and the hub from a burst). */
export const PREFETCH_CONCURRENCY = 2

export type CueApi = (path: string, init: { method: string; json: { text: string }; signal?: AbortSignal }) => Promise<Response>

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
  /** Object URLs of phrases that are ready to play at once. */
  private urls = new Map<string, string>()
  /** Voice key of the cached audio (undefined: memory only). */
  private key: Promise<string | undefined> = Promise.resolve(undefined)
  private audio: Playable
  private ctx: AudioContext | undefined
  /** Cancels prefetching on close(): queued phrases are skipped, in-flight synthesis is aborted. */
  private loading = new AbortController()
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

  earcon(name: EarconName): void {
    const ctx = this.ctx
    const parts: ReadonlyArray<{ freq?: number; ms?: number; gap?: number }> = EARCONS[name]
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

  /**
   * Loads every phrase, `PREFETCH_CONCURRENCY` at a time in the given order (call when Voice mode starts). With a voice `key` (TTS provider, model,
   * voice, speed) the audio is read from and stored in Cache Storage, and other voices' entries are dropped.
   * Never rejects: a phrase that fails stays unready (its cue plays the tone) and is tried again next time.
   */
  async prefetch(texts: readonly string[], key?: string | Promise<string | undefined>): Promise<void> {
    this.key = Promise.resolve(key).catch(() => undefined)
    const queue = [...texts]
    const { signal } = this.loading
    const worker = async () => {
      for (let text = queue.shift(); text !== undefined && !signal.aborted; text = queue.shift()) await this.phrase(text).catch(() => undefined)
    }
    await Promise.all([this.prune(), ...Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queue.length) }, worker)])
  }

  /** True when `text` plays at once (no synthesis needed). */
  ready(text: string): boolean {
    return this.urls.has(text)
  }

  /** Object URL for a fixed phrase: loaded once per page (from Cache Storage when possible). */
  phrase(text: string): Promise<string> {
    let url = this.phrases.get(text)
    if (!url) {
      url = this.load(text)
      this.phrases.set(text, url)
      url.catch(() => this.phrases.delete(text))
    }
    return url
  }

  private async load(text: string): Promise<string> {
    const { signal } = this.loading
    const key = await this.key
    const store = key ? await cueStore() : undefined
    const request = key ? cueURL(key, text) : ""
    let blob = store ? await store.match(request).then((res) => res?.blob(), () => undefined) : undefined
    if (!blob) {
      blob = await (await this.api("/api/speak", { method: "POST", json: { text }, signal })).blob()
      await store?.put(request, new Response(blob, { headers: { "content-type": blob.type || "audio/mpeg" } })).catch(() => {})
    }
    const url = URL.createObjectURL(blob)
    this.urls.set(text, url)
    return url
  }

  /** Drops cached cue audio of other voices. */
  private async prune(): Promise<void> {
    const key = await this.key
    const store = key ? await cueStore() : undefined
    if (!store || !key) return
    try {
      for (const request of await store.keys()) if (!request.url.startsWith(cueFolder(key))) await store.delete(request)
    } catch {
      // best-effort
    }
  }

  /**
   * Speaks a phrase. A ready phrase starts playing synchronously (well within 50 ms of its trigger); one that
   * is not ready plays the short "pending" tone instead and keeps loading for next time.
   */
  say(text: string): Promise<void> {
    const url = this.urls.get(text)
    if (!url) {
      this.earcon("pending")
      this.phrase(text).catch(() => {}) // cues are best-effort
      return Promise.resolve()
    }
    return this.playURL(url)
  }

  private async playURL(url: string): Promise<void> {
    const audio = this.audio
    this.setSpeaking(true)
    audio.src = url
    applyRate(audio, this.speed?.() ?? 1)
    // Listen before play() so a very short phrase cannot end unnoticed.
    const finished = new Promise<void>((resolve) => {
      audio.onended = audio.onpause = audio.onerror = () => resolve()
    })
    const played = await audio.play().then(
      () => true,
      () => false,
    )
    if (played) await finished
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
    // Free the connections: on HTTP/1.1 a long prefetch would hold requests (Voice off, replies) behind it.
    this.loading.abort()
    this.loading = new AbortController()
    this.ctx?.close?.().catch(() => {})
    this.ctx = undefined
  }
}
