// The ongoing "Voice mode on" notification and Media Session (web/src/core/voice-notifier.ts), driven by the
// real VoiceController with a fake conversation, a fake notification surface, fake media session and a fake clock.
import { describe, expect, test } from "bun:test"
import { VoiceController, type VoiceConversation } from "../web/src/core/voice-controller"
import { VOICE_NOTIFY_INTERVAL_MS, VoiceNotifier, voiceNotification, type VoiceSurface } from "../web/src/core/voice-notifier"
import type { ConversationUI } from "../web/src/voice/conversation"

class FakeConversation implements VoiceConversation {
  paused = false
  agent = "voice"
  constructor(
    readonly sessionID: string,
    readonly ui: ConversationUI<string>,
  ) {}
  async start() {
    this.ui.state("listening")
    return true
  }
  async stop() {
    this.ui.state("off")
    this.ui.ended()
  }
  pause() {
    this.paused = true
  }
  resume() {
    this.paused = false
  }
  onEvent() {}
  onStatus() {}
  async sendTyped() {}
}

function setup({ allowed = true } = {}) {
  let clock = 1_000
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextID = 0
  const convs: FakeConversation[] = []
  const controller = new VoiceController<FakeConversation>({
    expose: async () => true,
    create: (id, ui) => {
      const c = new FakeConversation(id, ui)
      convs.push(c)
      return c
    },
    stopPlayback: () => {},
    notify: () => {},
  })
  const shown: Array<{ sessionID: string; title: string; body: string }> = []
  let closed = 0
  const media: Array<{ title: string; artist: string } | null> = []
  let mediaEnd: (() => void) | undefined
  let permission = allowed
  const surface: VoiceSurface = {
    allowed: () => permission,
    show: (n) => void shown.push(n),
    close: () => void closed++,
    media: (meta, onEnd) => {
      media.push(meta)
      mediaEnd = onEnd
    },
  }
  const notifier = new VoiceNotifier(controller, surface, {
    title: (id) => (id === "ses_a" ? "API server" : "Docs"),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++nextID
      timers.push({ at: clock + ms, fn, id })
      return id
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id)
      if (i >= 0) timers.splice(i, 1)
    },
  })
  const advance = (ms: number) => {
    clock += ms
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at > clock) continue
      timers.splice(timers.indexOf(t), 1)
      t.fn()
    }
  }
  return {
    controller,
    notifier,
    convs,
    shown,
    media,
    closed: () => closed,
    mediaEnd: () => mediaEnd,
    advance,
    setPermission: (on: boolean) => (permission = on),
  }
}

describe("voiceNotification", () => {
  test("title, body with the session and the state in words", () => {
    expect(voiceNotification("ses_a", "API server", "listening")).toEqual({ sessionID: "ses_a", title: "Voice mode on", body: "API server · listening" })
    expect(voiceNotification("ses_a", "API server", "hearing").body).toBe("API server · listening")
    expect(voiceNotification("ses_a", "API server", "transcribing").body).toBe("API server · thinking")
    expect(voiceNotification("ses_a", "API server", "sent").body).toBe("API server · thinking")
    expect(voiceNotification("ses_a", "API server", "speaking").body).toBe("API server · speaking")
    expect(voiceNotification("ses_a", "API server", "paused").body).toBe("API server · muted")
    expect(voiceNotification("ses_a", "API server", "starting").body).toBe("API server · starting")
  })
})

describe("VoiceNotifier", () => {
  test("shows while Voice mode is on, sets media metadata, closes when it ends", async () => {
    const t = setup()
    await t.controller.start("ses_a")
    expect(t.shown.at(-1)).toEqual({ sessionID: "ses_a", title: "Voice mode on", body: "API server · listening" })
    expect(t.media.at(-1)).toEqual({ title: "Voice mode on", artist: "API server" })
    await t.controller.stop()
    expect(t.closed()).toBeGreaterThan(0)
    expect(t.media.at(-1)).toBeNull()
  })

  test("state changes update the body at most once per interval, with the latest state", async () => {
    const t = setup()
    await t.controller.start("ses_a")
    const count = t.shown.length
    const ui = t.convs[0]!.ui
    ui.state("transcribing")
    ui.state("speaking")
    expect(t.shown.length).toBe(count) // throttled
    t.advance(VOICE_NOTIFY_INTERVAL_MS)
    expect(t.shown.length).toBe(count + 1)
    expect(t.shown.at(-1)!.body).toBe("API server · speaking")
    // Level changes alone never re-show.
    ui.level(0.5)
    t.advance(VOICE_NOTIFY_INTERVAL_MS * 2)
    expect(t.shown.length).toBe(count + 1)
  })

  test("End from the media session or the notification ends Voice mode", async () => {
    const t = setup()
    await t.controller.start("ses_a")
    t.mediaEnd()!()
    await Promise.resolve()
    expect(t.controller.state.phase).toBe("off")
    await t.controller.start("ses_b")
    expect(t.shown.at(-1)!.body).toBe("Docs · listening")
    await t.notifier.endFromNotification("ses_a") // stale: another session is on now
    expect(t.controller.state.phase).toBe("on")
    await t.notifier.endFromNotification("ses_b")
    expect(t.controller.state.phase).toBe("off")
  })

  test("switching sessions re-shows for the new one; a pending update of the old one is dropped", async () => {
    const t = setup()
    await t.controller.start("ses_a")
    t.convs[0]!.ui.state("speaking")
    await t.controller.start("ses_b")
    t.advance(VOICE_NOTIFY_INTERVAL_MS)
    expect(t.shown.every((n, i) => i < 1 || n.sessionID === "ses_b" || n.body !== "API server · speaking")).toBe(true)
    expect(t.shown.at(-1)!.sessionID).toBe("ses_b")
  })

  test("without notification permission: nothing shown, the hint is on; media controls still set", async () => {
    const t = setup({ allowed: false })
    await t.controller.start("ses_a")
    expect(t.shown).toEqual([])
    expect(t.notifier.needsPermission()).toBe(true)
    expect(t.media.at(-1)).toEqual({ title: "Voice mode on", artist: "API server" })
    t.setPermission(true)
    t.notifier.refresh()
    expect(t.notifier.needsPermission()).toBe(false)
    expect(t.shown.at(-1)!.body).toBe("API server · listening")
    await t.controller.stop()
    expect(t.notifier.needsPermission()).toBe(false)
  })

  test("dispose closes the notification (page unload)", async () => {
    const t = setup()
    await t.controller.start("ses_a")
    const before = t.closed()
    t.notifier.dispose()
    expect(t.closed()).toBe(before + 1)
  })
})
