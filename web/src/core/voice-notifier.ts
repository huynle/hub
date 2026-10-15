// The ongoing "Voice mode on" system notification and the Media Session while Voice mode is on, following the
// app-level VoiceController. The notification says which session and what Voice is doing ("API server ·
// listening"), updated at most every VOICE_NOTIFY_INTERVAL_MS; its End action and the lock screen's pause/stop
// end Voice mode. No DOM: showing, closing and the media session are injected (web/src/app/voice.ts).
import type { ConversationState } from "../voice/conversation"
import type { VoiceController, VoiceConversation } from "./voice-controller"

/** Fewest milliseconds between two updates of the notification. */
export const VOICE_NOTIFY_INTERVAL_MS = 3000
export const VOICE_NOTIFICATION_TITLE = "Voice mode on"

export interface VoiceNotificationContent {
  readonly sessionID: string
  readonly title: string
  readonly body: string
}

/** Where the notification and the lock-screen controls go. */
export interface VoiceSurface {
  /** Notification permission is granted and a service worker can show notifications. */
  allowed(): boolean
  show(notification: VoiceNotificationContent): void
  close(): void
  /** Media Session metadata (null clears it); `onEnd` is for pause and stop. */
  media(meta: { title: string; artist: string } | null, onEnd?: () => void): void
}

export interface VoiceNotifierOptions {
  /** The session's title. */
  title(sessionID: string): string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: any) => void
}

const STATE_WORDS: Record<ConversationState, string> = {
  starting: "starting",
  listening: "listening",
  hearing: "listening",
  transcribing: "thinking",
  sent: "thinking",
  speaking: "speaking",
  paused: "muted",
  off: "off",
}

export const voiceNotification = (sessionID: string, title: string, state: ConversationState): VoiceNotificationContent => ({
  sessionID,
  title: VOICE_NOTIFICATION_TITLE,
  body: `${title} · ${STATE_WORDS[state] ?? state}`,
})

export class VoiceNotifier<C extends VoiceConversation = VoiceConversation> {
  private shown: VoiceNotificationContent | undefined
  private shownAt = 0
  private timer: unknown
  /** Session whose media metadata is set. */
  private mediaFor: string | undefined
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: any) => void
  private readonly unsubscribe: () => void

  constructor(
    private readonly controller: VoiceController<C>,
    private readonly surface: VoiceSurface,
    private readonly options: VoiceNotifierOptions,
  ) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
    this.unsubscribe = controller.subscribe(() => this.refresh())
  }

  /** Voice mode is on but notifications are not allowed (the Voice bar shows a hint). */
  needsPermission(): boolean {
    return this.controller.state.phase === "on" && !this.surface.allowed()
  }

  /** The notification's End (from the service worker): ends Voice mode if that session is still in it. */
  async endFromNotification(sessionID: string): Promise<void> {
    if (this.controller.state.phase !== "off" && this.controller.state.sessionID === sessionID) await this.controller.end()
  }

  /** Re-evaluates (state changed, or permission was granted). */
  refresh(): void {
    const state = this.controller.state
    if (state.phase !== "on" || !state.sessionID) return this.clear()
    const sessionID = state.sessionID
    const title = this.options.title(sessionID)
    if (this.mediaFor !== sessionID) {
      this.mediaFor = sessionID
      this.surface.media({ title: VOICE_NOTIFICATION_TITLE, artist: title }, () => void this.controller.end())
    }
    if (!this.surface.allowed()) return
    const next = voiceNotification(sessionID, title, state.voice)
    if (this.shown && this.shown.sessionID === next.sessionID && this.shown.body === next.body) return this.cancel()
    const wait = this.shown?.sessionID === sessionID ? this.shownAt + VOICE_NOTIFY_INTERVAL_MS - this.now() : 0
    if (wait <= 0) return this.show(next)
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => {
        this.timer = undefined
        this.refresh()
      }, wait)
    }
  }

  /** Page unload: closes the notification and stops following the controller. */
  dispose(): void {
    this.unsubscribe()
    this.cancel()
    this.surface.close()
    if (this.mediaFor) this.surface.media(null)
    this.shown = this.mediaFor = undefined
  }

  private show(notification: VoiceNotificationContent): void {
    this.cancel()
    this.surface.show(notification)
    this.shown = notification
    this.shownAt = this.now()
  }

  private clear(): void {
    this.cancel()
    if (this.shown) this.surface.close()
    if (this.mediaFor) this.surface.media(null)
    this.shown = this.mediaFor = undefined
  }

  private cancel(): void {
    if (this.timer === undefined) return
    this.clearTimer(this.timer)
    this.timer = undefined
  }
}
