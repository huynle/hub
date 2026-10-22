// Browser side of cue loudness (the measurements are pure, in core/loudness.ts): decodes audio with an
// OfflineAudioContext (no playback graph: cues and replies keep playing through plain <audio> elements,
// which keeps background and iOS playback working), normalises cue phrases to the replies' loudness while
// they are prefetched, and measures completed reply sentences when the page is idle (a running median per
// TTS voice in localStorage becomes the cues' target).
import { cueTarget, encodeWav16, loudness, normalizeCue, recordReplyLoudness } from "../core/loudness"

/** Decoding rate: the TTS voices are 24 kHz (a lower rate would dull the cue, a higher one only adds bytes). */
const DECODE_RATE = 24_000
/** Replies shorter than this are not measured (too short for a stable gated loudness). */
const MIN_REPLY_S = 1
/** Reply measurements waiting for idle time (more are dropped: one sentence in a few is plenty). */
const MAX_PENDING = 2

type OfflineCtor = new (channels: number, length: number, rate: number) => BaseAudioContext

async function decodeMono(data: ArrayBuffer): Promise<{ samples: Float32Array; rate: number }> {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor }
  const Offline = g.OfflineAudioContext || g.webkitOfflineAudioContext
  if (!Offline) throw new Error("No OfflineAudioContext here")
  const ctx = new Offline(1, 1, DECODE_RATE)
  // Old Safari only has the callback form (and returns undefined).
  const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
    const promise = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined
    promise?.then(resolve, reject)
  })
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  if (channels.length === 1) return { samples: channels[0]!, rate: buffer.sampleRate }
  const samples = new Float32Array(buffer.length)
  for (const channel of channels) for (let i = 0; i < samples.length; i++) samples[i]! += channel[i]! / channels.length
  return { samples, rate: buffer.sampleRate }
}

/** CuePlayer's normaliser: the phrase trimmed and gained to `target` LUFS, as a 16-bit mono WAV. */
export async function normalizeCueAudio(audio: Blob, target: number): Promise<Blob> {
  const { samples, rate } = await decodeMono(await audio.arrayBuffer())
  const normalized = normalizeCue(samples, rate, target)
  return new Blob([encodeWav16(normalized.samples, rate)], { type: "audio/wav" })
}

/** The loudness (LUFS) cues of a voice are normalised to. */
export function cueLoudnessTarget(key: string | undefined): number {
  try {
    return cueTarget(localStorage, key)
  } catch {
    return cueTarget({ getItem: () => null, setItem: () => {} }, key)
  }
}

let pending = 0

const whenIdle = (run: () => void) => {
  const g = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  if (g.requestIdleCallback) g.requestIdleCallback(run, { timeout: 5_000 })
  else setTimeout(run, 500)
}

/** Measures a completed reply sentence's loudness when the page is idle and remembers it for its voice. */
export function measureReply(chunks: readonly Uint8Array[], key: string | undefined): void {
  if (!key || !chunks.length || pending >= MAX_PENDING) return
  pending++
  whenIdle(() => {
    void (async () => {
      try {
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
        let at = 0
        for (const chunk of chunks) {
          bytes.set(chunk, at)
          at += chunk.byteLength
        }
        const { samples, rate } = await decodeMono(bytes.buffer)
        if (samples.length < rate * MIN_REPLY_S) return
        recordReplyLoudness(localStorage, key, loudness(samples, rate))
      } catch {
        // undecodable or no storage: the target stays as it was
      } finally {
        pending--
      }
    })()
  })
}
