import { describe, expect, test } from "bun:test"
import { parseOptions } from "../src/options"

describe("parseOptions", () => {
  test("uses the agreed defaults", () => {
    expect(parseOptions({})).toEqual({
      host: "127.0.0.1",
      port: 4097,
      sttModel: "openai/gpt-4o-mini-transcribe",
      ttsModel: "microsoft/mai-voice-2.1-flash",
      voice: "en-US-Harper:MAI-Voice-2.1-Flash",
      maxAudioBytes: 10 * 1024 * 1024,
      maxSpeechChars: 800,
      turnTimeoutMs: 10 * 60 * 1000,
    })
  })

  test("accepts overrides", () => {
    const options = parseOptions({ port: 5000, voice: "nova", publicURL: "https://mac.tailnet.ts.net/", apiKey: "sk" })
    expect(options).toMatchObject({ port: 5000, voice: "nova", publicURL: "https://mac.tailnet.ts.net", apiKey: "sk" })
  })

  test("ignores values of the wrong type", () => {
    expect(parseOptions({ port: "80", voice: 3, maxSpeechChars: -1 })).toMatchObject({
      port: 4097,
      voice: "en-US-Harper:MAI-Voice-2.1-Flash",
      maxSpeechChars: 800,
    })
  })
})
