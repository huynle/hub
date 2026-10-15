// /voice: no menu. Makes sure the hub is set up and connected (running the /hub setup first when it is not),
// shares the session on screen for Voice, and opens it in the browser with Voice mode starting
// (`/s/<id>?voice=1` through a one-time sign-in link). The TUI (src/tui.ts) supplies the dialogs and RPCs.
import { needsSetup, type Mode } from "./setup"

/** The parts of hub.status the flow reads. */
export interface VoiceStatus {
  readonly server: string
  readonly mode: Mode
  readonly enrolled: boolean
  readonly connection: "off" | "connecting" | "connected" | "revoked" | "error"
  readonly sessionExposed?: boolean
  readonly localHub?: string
  readonly lastError?: string
}

export interface VoiceCommandDeps {
  /** The session on screen. */
  sessionID(): string | undefined
  status(sessionID: string): Promise<VoiceStatus>
  /** The /hub first-run setup (without opening the browser); resolves when the user finished or left it. */
  setup(status: VoiceStatus): Promise<void>
  /** /hub → Mode, for a machine whose sharing is off. */
  chooseMode(status: VoiceStatus): Promise<void>
  /** Connects (starting a local hub when needed) and waits; throws with the reason when it can't. */
  connect(status: VoiceStatus): Promise<VoiceStatus>
  /** Shares the session for Voice (this session on). */
  expose(sessionID: string): Promise<void>
  openLink(sessionID: string, voice: true): Promise<{ url: string }>
  /** Opens the link in the browser (and says so), or shows it. */
  showLink(url: string, what: string): Promise<void>
  toast(message: string, variant: "info" | "success" | "warning" | "error"): void
}

export type VoiceOutcome = "opened" | "no-session" | "not-set-up" | "off"

export async function startVoice(deps: VoiceCommandDeps): Promise<VoiceOutcome> {
  const sessionID = deps.sessionID()
  if (!sessionID) {
    deps.toast("Open a session first, then run /voice to talk to it in the browser.", "warning")
    return "no-session"
  }
  let s = await deps.status(sessionID)
  if (needsSetup(s)) {
    await deps.setup(s)
    s = await deps.status(sessionID)
    if (needsSetup(s)) {
      deps.toast("Finish setting up the hub (approve this machine if asked), then run /voice again.", "warning")
      return "not-set-up"
    }
  }
  if (s.mode === "off") {
    await deps.chooseMode(s)
    s = await deps.status(sessionID)
    if (s.mode === "off") {
      deps.toast("Sharing with the hub is off for this machine. Choose a mode in /hub, then run /voice again.", "warning")
      return "off"
    }
  }
  if (s.connection !== "connected") s = await deps.connect(s)
  if (!s.sessionExposed) await deps.expose(sessionID)
  const { url } = await deps.openLink(sessionID, true)
  await deps.showLink(url, "Voice mode for this session")
  return "opened"
}
