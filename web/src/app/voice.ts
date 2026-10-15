// App-level microphone state shared by every session view: Voice mode (one session at a time, kept running
// while other sessions are viewed), per-session drafts and dictation (the composer's mic button). A dictation
// belongs to the session it was started in; leaving that session cancels it, and Voice mode elsewhere is muted
// while it records.
import { createSignal } from "solid-js"
import { Dictation } from "../core/dictation-core"
import { VoiceController } from "../core/voice-controller"
import { Drafts } from "../lib/composer"
import { micDevice, player, startDictation, voicePrefs } from "../voice/audio"
import { Conversation } from "../voice/conversation"
import { api } from "./api"
import { lookup, onMessage, setVoice } from "./hub"
import { toast } from "./toast"

// ---------- Voice mode ----------

export const voice = new VoiceController<Conversation<string>>({
  async expose(sessionID) {
    const exposed = () => lookup(sessionID)?.session.exposed !== false
    if (exposed()) return true
    if (!(await setVoice(sessionID, true))) return false
    // Wait (briefly) for the catalog to report Voice on before starting.
    for (let i = 0; i < 25 && !exposed(); i++) await new Promise((r) => setTimeout(r, 200))
    return true
  },
  create: (sessionID, ui) =>
    new Conversation<string>({
      sessionID,
      api,
      player,
      ui,
      options: {
        cues: voicePrefs.cues,
        background: voicePrefs.background,
        speed: () => voicePrefs.speed,
        title: () => lookup(sessionID)?.session.title || "OpenCode session",
        status: lookup(sessionID)?.session.status,
        deviceId: micDevice() || undefined,
      },
    }),
  stopPlayback: () => {
    if (!player.paused) player.pause()
  },
  notify: (text, kind) => toast(text, kind === "err" ? "err" : ""),
})

const [voiceRev, setVoiceRev] = createSignal(0)
voice.subscribe(() => setVoiceRev((n) => n + 1))

/** The Voice mode state (reactive). */
export function voiceState() {
  voiceRev()
  return voice.state
}

/** Title of the session in Voice mode (for the indicator shown while viewing elsewhere). */
export const voiceTitle = () => {
  const id = voiceState().sessionID
  return id ? lookup(id)?.session.title || "Session" : ""
}

// The conversation follows its session's events wherever the user is in the console.
onMessage((m) => {
  if (m.type === "say" || m.type === "heard" || m.type === "conversation") voice.onEvent(m)
  else if (m.type === "status" && typeof m.sessionID === "string" && Array.isArray(m.sessions)) voice.onStatus(m.sessionID, m.sessions)
})
window.addEventListener("pagehide", () => void voice.stop({ keepalive: true }))

// ---------- drafts and dictation ----------

/** Unsent text per session. */
export const drafts = new Drafts()

export const dictation = new Dictation({
  record: (onTick) => startDictation(onTick),
  deliver: (sessionID, text) => void drafts.append(sessionID, text),
  notify: (text, kind) => toast(text, kind),
  // Voice mode in another session would hear the dictation: mute it while recording.
  hold: () => voice.hold(),
})

const [dictationRev, setDictationRev] = createSignal(0)
dictation.subscribe(() => setDictationRev((n) => n + 1))

/** What the mic button of a session shows (reactive). */
export function dictationFor(sessionID: string): { recording: false | number; transcribing: boolean } {
  dictationRev()
  return dictation.forSession(sessionID)
}
