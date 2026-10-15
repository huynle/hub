// /s/<id>?voice=1 (from /voice in the TUI) and when a blocked start needs a tap (web/src/core/voice-autostart.ts).
import { describe, expect, test } from "bun:test"
import { gestureBlocked, takeVoiceParam } from "../web/src/core/voice-autostart"

describe("takeVoiceParam", () => {
  test("voice=1 is taken out of the URL; other params and the hash stay", () => {
    expect(takeVoiceParam("https://hub.example.com/s/ses_1?voice=1")).toEqual({ voice: true, path: "/s/ses_1" })
    expect(takeVoiceParam("https://hub.example.com/s/ses_1?a=b&voice=1#x")).toEqual({ voice: true, path: "/s/ses_1?a=b#x" })
    expect(takeVoiceParam("https://hub.example.com/s/ses_1")).toEqual({ voice: false, path: "/s/ses_1" })
    // Anything but 1 is not a request, but is still removed.
    expect(takeVoiceParam("https://hub.example.com/s/ses_1?voice=0")).toEqual({ voice: false, path: "/s/ses_1" })
  })
})

describe("gestureBlocked", () => {
  test("a suspended AudioContext needs a tap", () => {
    expect(gestureBlocked({ audioState: "suspended", activated: false })).toBe(true)
    expect(gestureBlocked({ audioState: "running", activated: false })).toBe(false)
  })
  test("a refused microphone without any tap on the page needs a tap, unless the site is denied", () => {
    expect(gestureBlocked({ error: "NotAllowedError", micPermission: "prompt", activated: false })).toBe(true)
    expect(gestureBlocked({ error: "NotAllowedError", micPermission: "unknown", activated: false })).toBe(true)
    expect(gestureBlocked({ error: "NotAllowedError", micPermission: "denied", activated: false })).toBe(false)
    expect(gestureBlocked({ error: "NotAllowedError", micPermission: "prompt", activated: true })).toBe(false)
    expect(gestureBlocked({ error: "NotFoundError", micPermission: "prompt", activated: false })).toBe(false)
  })
})
