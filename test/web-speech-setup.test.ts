// Speech onboarding on the page: when the "Set up speech" banner shows, whether the mic is usable, and the
// local-hub note about where keys are stored.
import { describe, expect, test } from "bun:test"
import { speechSetup } from "../web/src/core/feedback-core"

const REASON = "Speech-to-text needs an OpenRouter API key. Set it in Settings → Speech."

describe("speechSetup", () => {
  test("nothing to set up when both directions are ready, or the hub predates `ready`", () => {
    expect(speechSetup({ stt: true, tts: true }, "http://127.0.0.1:4097")).toBeUndefined()
    expect(speechSetup(undefined, "http://127.0.0.1:4097")).toBeUndefined()
  })

  test("no speech-to-text: the mic is blocked and the hub's reason is shown", () => {
    const setup = speechSetup({ stt: false, tts: true, reason: REASON }, "https://voice.example.com")
    expect(setup).toMatchObject({ micBlocked: true, reason: REASON })
    expect(setup!.storage).toBeUndefined()
  })

  test("only text-to-speech missing: the mic still works (replies show as text)", () => {
    expect(speechSetup({ stt: true, tts: false }, "https://voice.example.com")).toMatchObject({ micBlocked: false, reason: expect.stringContaining("Settings → Speech") })
  })

  test("a loopback hub says the keys stay on this computer", () => {
    for (const url of ["http://127.0.0.1:4097", "http://localhost:4555", "http://[::1]:4097"]) {
      expect(speechSetup({ stt: false, tts: false, reason: REASON }, url)!.storage).toBe("Keys are stored on this computer in ~/.local/state/hub")
    }
    expect(speechSetup({ stt: false, tts: false, reason: REASON }, "http://10.0.0.20:4097")!.storage).toBeUndefined()
    expect(speechSetup({ stt: false, tts: false, reason: REASON }, "not a url")!.storage).toBeUndefined()
  })
})
