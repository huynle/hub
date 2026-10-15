// App-level microphone state shared by every session view: per-session drafts and dictation (the composer's
// mic button). A dictation belongs to the session it was started in; leaving that session cancels it.
import { createSignal } from "solid-js"
import { Dictation } from "../core/dictation-core"
import { Drafts } from "../lib/composer"
import { startDictation } from "../voice/audio"
import { toast } from "./toast"

/** Unsent text per session. */
export const drafts = new Drafts()

export const dictation = new Dictation({
  record: (onTick) => startDictation(onTick),
  deliver: (sessionID, text) => void drafts.append(sessionID, text),
  notify: (text, kind) => toast(text, kind),
})

const [dictationRev, setDictationRev] = createSignal(0)
dictation.subscribe(() => setDictationRev((n) => n + 1))

/** What the mic button of a session shows (reactive). */
export function dictationFor(sessionID: string): { recording: false | number; transcribing: boolean } {
  dictationRev()
  return dictation.forSession(sessionID)
}
