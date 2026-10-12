// Types for web/cues.js (plain ES module used by the PWA without a build step).
import type { Cue } from "./feedback-core.js"

type Playable = Pick<HTMLAudioElement, "src" | "paused" | "playbackRate" | "defaultPlaybackRate" | "preservesPitch" | "play" | "pause" | "onended" | "onpause" | "onerror">

/** Sets the playback rate (kept across source changes) with pitch preserved. */
export function applyRate(audio: Partial<Playable> & { webkitPreservesPitch?: boolean }, rate: number): void

export class CuePlayer {
  constructor(options: {
    api: (path: string, init: { method: string; json: { text: string } }) => Promise<Response>
    speed?: () => number
    onSpeaking?: (speaking: boolean) => void
    audio?: unknown
  })
  readonly speaking: boolean
  unlock(): void
  play(cues: readonly Cue[] | undefined): void
  earcon(name: "heard" | "done"): void
  phrase(text: string): Promise<string>
  say(text: string): Promise<void>
  stop(): void
  close(): void
}
