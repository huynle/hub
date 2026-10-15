// Voice mode started from a link (/s/<id>?voice=1, opened by /voice in the TUI) and starts the browser
// blocks until the user taps the page. Pure logic (bun tests in test/web-voice-autostart.test.ts).

/** Whether the URL asks for Voice mode, and the same-origin path without the `voice` param. */
export function takeVoiceParam(href: string): { voice: boolean; path: string } {
  const url = new URL(href)
  const voice = url.searchParams.get("voice") === "1"
  url.searchParams.delete("voice")
  return { voice, path: `${url.pathname}${url.search}${url.hash}` }
}

export interface StartFailure {
  /** The getUserMedia error's name. */
  readonly error?: string
  /** The microphone permission ("unknown" when the Permissions API can't tell). */
  readonly micPermission?: "granted" | "denied" | "prompt" | "unknown"
  /** The page has had a user gesture (navigator.userActivation.hasBeenActive). */
  readonly activated: boolean
  /** The AudioContext state after resume(). */
  readonly audioState?: string
}

/** The start failed only because the page has not been tapped yet: offer "Tap to start" instead of an error. */
export function gestureBlocked(failure: StartFailure): boolean {
  if (failure.audioState === "suspended") return true
  return failure.error === "NotAllowedError" && !failure.activated && failure.micPermission !== "denied"
}
