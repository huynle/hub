// Per-device voice preferences, the shared audio player, the microphone choice with a level meter, and
// dictation (record → /api/transcribe → text for the composer).
import { createSignal } from "solid-js"
import { applyRate } from "../core/cues"
import { clampSpeed } from "../core/feedback-core"
import { parseSensitivity, type Sensitivity } from "../core/speech-vad"
import { api } from "../app/api"
import { micConstraints } from "./conversation"

const PREF_SPEED = "voice.speed"
const PREF_CUES = "voice.cues"
const PREF_BACKGROUND = "voice.background"
const PREF_MIC = "voice.micDevice"
const PREF_SENSITIVITY = "voice.sensitivity"
/** Kept in memory: a running conversation reads it for every mic frame. */
let sensitivity = parseSensitivity(localStorage.getItem(PREF_SENSITIVITY))

export const voicePrefs = {
  get speed() {
    return clampSpeed(localStorage.getItem(PREF_SPEED))
  },
  set speed(value: number) {
    localStorage.setItem(PREF_SPEED, String(clampSpeed(value)))
    applyRate(player, clampSpeed(value))
  },
  get cues() {
    return localStorage.getItem(PREF_CUES) !== "0"
  },
  set cues(on: boolean) {
    localStorage.setItem(PREF_CUES, on ? "1" : "0")
  },
  get background() {
    return localStorage.getItem(PREF_BACKGROUND) === "1"
  },
  set background(on: boolean) {
    localStorage.setItem(PREF_BACKGROUND, on ? "1" : "0")
  },
  /** Mic sensitivity of Voice mode's speech detection (read live by a running conversation). */
  get sensitivity(): Sensitivity {
    return sensitivity
  },
  set sensitivity(level: Sensitivity) {
    sensitivity = parseSensitivity(level)
    localStorage.setItem(PREF_SENSITIVITY, sensitivity)
  },
}

/** The one audio element for replies and previews. */
export const player = new Audio()
player.preload = "none"
player.volume = 1 // progress cues play at the same volume (web/src/core/cues.ts)
applyRate(player, voicePrefs.speed)

/** Browsers (iOS especially) only allow playback started from a gesture: prime the player during the tap. */
export function unlockAudio(): void {
  if (!player.paused) return
  player.muted = true
  player
    .play()
    .catch(() => {})
    .finally(() => {
      player.pause()
      player.muted = false
    })
}

// ---------- microphone choice ----------

const [micDevice, setMicDeviceRaw] = createSignal(localStorage.getItem(PREF_MIC) ?? "")
export { micDevice }
export function setMicDevice(id: string): void {
  setMicDeviceRaw(id)
  localStorage.setItem(PREF_MIC, id)
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  let devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput")
  if (devices.length && devices.every((d) => !d.label)) {
    // Labels appear only after a permission grant.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput")
    } catch {
      // no permission: unnamed devices
    }
  }
  return devices
}

/** Live input level (0–1) of a device until the returned stop function is called. */
export async function levelMeter(deviceId: string, onLevel: (level: number) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints(deviceId || undefined))
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
  const data = new Float32Array(analyser.fftSize)
  let frame = 0
  const loop = () => {
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (const x of data) sum += x * x
    const db = 20 * Math.log10(Math.max(Math.sqrt(sum / data.length), 1e-7))
    onLevel(Math.max(0, Math.min(1, (db + 60) / 50)))
    frame = requestAnimationFrame(loop)
  }
  loop()
  return () => {
    cancelAnimationFrame(frame)
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }
}

// ---------- dictation ----------

const MAX_RECORD_MS = 60_000

function pickType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (window.MediaRecorder?.isTypeSupported?.(type)) return type
  }
  return ""
}

export interface Dictation {
  /** Stops recording and transcribes; resolves with the text ("" when nothing was heard). */
  finish(): Promise<string>
  cancel(): void
}

/** Starts recording from the chosen mic. Throws with a readable message when the browser cannot. */
export async function startDictation(onTick?: (secondsLeft: number) => void): Promise<Dictation> {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("This browser cannot record here (the microphone needs HTTPS).")
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia(micConstraints(micDevice() || undefined))
  } catch (e) {
    const err = e as Error
    throw new Error(err.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in the browser's site settings." : `Microphone: ${err.message}`)
  }
  const mimeType = pickType()
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  const started = Date.now()
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  let discard = false
  const done = new Promise<string>((resolve, reject) => {
    recorder.onstop = async () => {
      clearInterval(tick)
      clearTimeout(limit)
      stream.getTracks().forEach((t) => t.stop())
      if (discard) return resolve("")
      const blob = new Blob(chunks, { type: (recorder.mimeType || mimeType || "audio/webm").split(";")[0] })
      if (!blob.size) return resolve("")
      try {
        const { text } = await (await api("/api/transcribe", { method: "POST", body: blob, headers: { "content-type": blob.type } })).json()
        resolve(String(text ?? "").trim())
      } catch (e) {
        const err = e as Error & { status?: number }
        reject(new Error(err.status === 413 ? "That recording was too long." : `Transcription failed: ${err.message}`))
      }
    }
  })
  recorder.start()
  const tick = setInterval(() => onTick?.(Math.max(0, Math.ceil((MAX_RECORD_MS - (Date.now() - started)) / 1000))), 1000)
  const limit = setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_RECORD_MS)
  return {
    finish() {
      if (recorder.state === "recording") recorder.stop()
      return done
    },
    cancel() {
      discard = true
      if (recorder.state === "recording") recorder.stop()
    },
  }
}
